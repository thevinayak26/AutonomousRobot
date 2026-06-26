// PID Motor Control Firmware for Arduino Mega  (clean rewrite 2026-06-27)
// Raw serial protocol (no rosserial):
//   Pi -> "V,leftTPS,rightTPS\n"   velocity mode (PID)
//   Pi -> "M,leftPWM,rightPWM\n"   raw PWM (no PID, fallback)
//   Pi -> "S\n"                    stop (exit PID, halt)
//   Pi -> "R\n"                    reset encoders
//   Pi -> "P,Kp,Ki,Kd\n"          tune gains live
//   Arduino -> "E,leftTicks,rightTicks\n"  every 50ms
//   Arduino -> "D,leftPWM,rightPWM\n"      every 50ms (debug: commanded PWM)
//
// CHANGES vs the old firmware (all aimed at killing stutter):
//   1. Derivative low-pass filter. Raw d(error)/dt on a 50ms encoder diff is
//      extremely noisy; that noise was injected straight into PWM = stutter.
//   2. Conditional integration (clamp-on-saturate) anti-windup. The integral
//      no longer keeps growing when PWM is already saturated, so it doesn't
//      dump a big correction later = no lurch.
//   3. Firmware-side slew limiter on the COMMANDED target velocity. Even if a
//      step target arrives, the internal target ramps smoothly = jerk-free.
//   4. Right encoder counts POSITIVE on forward in the ISR, so the PID
//      feedback line needs NO negation -> matches the co-owned ultrasonic
//      firmware convention. Keeps both builds consistent.
//
// NOTE on the right wheel: after the right-motor lead swap, the right encoder
// previously read negative on forward, which the OLD firmware patched with a
// negation in the velocity calc. This rewrite instead flips the right ISR so
// the count itself is positive on forward. Net feedback sign is identical;
// the code is now consistent with motor_control_pid_ultrasonic.ino.

// ===================== PINS =====================
#define ENC_LEFT_A 2
#define ENC_LEFT_B 4
#define ENC_RIGHT_A 3
#define ENC_RIGHT_B 5

#define M1_PWM 6
#define M1_DIR 7
#define M2_PWM 9
#define M2_DIR 8

// ===================== ENCODERS =====================
volatile long leftTicks = 0;
volatile long rightTicks = 0;

long prevLeftTicks = 0;
long prevRightTicks = 0;

// ===================== PID GAINS =====================
// Defaults; the bridge overrides these on connect via "P,".
float Kp = 0.15;
float Ki = 0.08;
float Kd = 0.0;

// ===================== PID STATE =====================
float leftErrorSum = 0;
float leftErrorPrev = 0;
float leftDerivFilt = 0;     // filtered derivative state
int   leftPWM = 0;

float rightErrorSum = 0;
float rightErrorPrev = 0;
float rightDerivFilt = 0;
int   rightPWM = 0;

// ===================== TARGETS / SLEW =====================
// commandedTargetVel = what the Pi asked for.
// rampedTargetVel    = what the PID actually chases (slew-limited).
float leftCmdVel = 0;
float rightCmdVel = 0;
float leftRampVel = 0;
float rightRampVel = 0;

bool pidMode = false;

// ===================== LIMITS / CONSTANTS =====================
const float integralLimit = 800.0;   // generous; conditional integration is the real guard
const int   minPWM = 30;             // static-friction floor
const float maxTPS = 3000.0;         // physical ceiling (on-ground ~2830 tps @255)
// Slew: max change in target tps per PID tick (50ms).
// 250 tps/tick @ 20 ticks/s = ~5000 tps/s => 0->2000 in ~0.4s. Smooth, not sluggish.
const float slewPerTick = 250.0;
// Derivative filter coefficient (0..1). Lower = more smoothing.
const float derivAlpha = 0.3;

// ===================== TIMING =====================
unsigned long lastPIDUpdate = 0;
unsigned long lastPublish = 0;
const unsigned long pidInterval = 50;
const unsigned long publishInterval = 50;

String inputBuffer = "";

// ===================== ISR =====================
void leftEncoderISR() {
  if (digitalRead(ENC_LEFT_B) == HIGH) leftTicks++;
  else                                 leftTicks--;
}

// Right ISR INVERTED vs left so the right wheel counts POSITIVE on forward
// (post motor-lead-swap). This removes the need to negate in the velocity calc.
void rightEncoderISR() {
  if (digitalRead(ENC_RIGHT_B) == HIGH) rightTicks--;
  else                                  rightTicks++;
}

// ===================== MOTOR =====================
void setMotor(int pwmPin, int dirPin, int speed) {
  if (speed >= 0) {
    digitalWrite(dirPin, LOW);
    analogWrite(pwmPin, constrain(speed, 0, 255));
  } else {
    digitalWrite(dirPin, HIGH);
    analogWrite(pwmPin, constrain(-speed, 0, 255));
  }
}

void resetPIDState() {
  leftErrorSum = 0; rightErrorSum = 0;
  leftErrorPrev = 0; rightErrorPrev = 0;
  leftDerivFilt = 0; rightDerivFilt = 0;
}

void stopMotors() {
  leftCmdVel = 0;  rightCmdVel = 0;
  leftRampVel = 0; rightRampVel = 0;
  leftPWM = 0;     rightPWM = 0;
  resetPIDState();
  setMotor(M1_PWM, M1_DIR, 0);
  setMotor(M2_PWM, M2_DIR, 0);
}

// ===================== SLEW LIMITER =====================
float slew(float cur, float tgt) {
  float d = tgt - cur;
  if (d >  slewPerTick) return cur + slewPerTick;
  if (d < -slewPerTick) return cur - slewPerTick;
  return tgt;
}

// ===================== PID =====================
// Conditional-integration anti-windup + filtered derivative.
int computePID(float target, float actual,
               float &errorSum, float &errorPrev, float &derivFilt, float dt) {
  float error = target - actual;

  // Filtered derivative (low-pass on the raw derivative).
  float rawDeriv = (dt > 0) ? (error - errorPrev) / dt : 0.0;
  derivFilt = derivAlpha * rawDeriv + (1.0 - derivAlpha) * derivFilt;
  errorPrev = error;

  // Tentative integral.
  float newSum = errorSum + error * dt;
  if (newSum >  integralLimit) newSum =  integralLimit;
  if (newSum < -integralLimit) newSum = -integralLimit;

  // Unsaturated output with tentative integral.
  float output = (Kp * error) + (Ki * newSum) + (Kd * derivFilt);

  // Conditional integration: only commit the integral if we are NOT pushing
  // further into saturation. Stops windup that causes post-saturation lurch.
  bool saturated = (output > 255.0) || (output < -255.0);
  bool drivingDeeper = (output > 0 && error > 0) || (output < 0 && error < 0);
  if (!(saturated && drivingDeeper)) {
    errorSum = newSum;   // accept
  }
  // else keep old errorSum (freeze integral)

  // Recompute with the committed integral.
  output = (Kp * error) + (Ki * errorSum) + (Kd * derivFilt);

  int pwm = (int)output;

  // Static-friction floor (only when actually commanding motion).
  if (target != 0 && pwm > 0 && pwm < minPWM) pwm = minPWM;
  if (target != 0 && pwm < 0 && pwm > -minPWM) pwm = -minPWM;
  if (target == 0 && abs(pwm) < minPWM) pwm = 0;

  return constrain(pwm, -255, 255);
}

// ===================== SERIAL =====================
void processCommand(String cmd) {
  if (cmd.startsWith("V,")) {
    int c1 = cmd.indexOf(',');
    int c2 = cmd.indexOf(',', c1 + 1);
    if (c2 == -1) return;
    float l = cmd.substring(c1 + 1, c2).toFloat();
    float r = cmd.substring(c2 + 1).toFloat();
    // Clamp to physical ceiling.
    l = constrain(l, -maxTPS, maxTPS);
    r = constrain(r, -maxTPS, maxTPS);
    leftCmdVel = l;
    rightCmdVel = r;
    pidMode = true;
  }
  else if (cmd.startsWith("M,")) {
    int c1 = cmd.indexOf(',');
    int c2 = cmd.indexOf(',', c1 + 1);
    if (c2 == -1) return;
    int ls = cmd.substring(c1 + 1, c2).toInt();
    int rs = cmd.substring(c2 + 1).toInt();
    pidMode = false;
    resetPIDState();
    setMotor(M1_PWM, M1_DIR, ls);
    setMotor(M2_PWM, M2_DIR, rs);
  }
  else if (cmd.startsWith("S")) {
    pidMode = false;
    stopMotors();
  }
  else if (cmd.startsWith("R")) {
    noInterrupts();
    leftTicks = 0;
    rightTicks = 0;
    interrupts();
    prevLeftTicks = 0;
    prevRightTicks = 0;
  }
  else if (cmd.startsWith("P,")) {
    int c1 = cmd.indexOf(',');
    int c2 = cmd.indexOf(',', c1 + 1);
    int c3 = cmd.indexOf(',', c2 + 1);
    if (c3 == -1) return;
    Kp = cmd.substring(c1 + 1, c2).toFloat();
    Ki = cmd.substring(c2 + 1, c3).toFloat();
    Kd = cmd.substring(c3 + 1).toFloat();
    resetPIDState();
    Serial.print("PID,");
    Serial.print(Kp, 3); Serial.print(",");
    Serial.print(Ki, 3); Serial.print(",");
    Serial.println(Kd, 3);
  }
}

// ===================== SETUP =====================
void setup() {
  Serial.begin(115200);

  pinMode(M1_PWM, OUTPUT); pinMode(M1_DIR, OUTPUT);
  pinMode(M2_PWM, OUTPUT); pinMode(M2_DIR, OUTPUT);
  analogWrite(M1_PWM, 0);  analogWrite(M2_PWM, 0);

  pinMode(ENC_LEFT_A, INPUT_PULLUP);  pinMode(ENC_LEFT_B, INPUT);
  pinMode(ENC_RIGHT_A, INPUT_PULLUP); pinMode(ENC_RIGHT_B, INPUT);

  attachInterrupt(digitalPinToInterrupt(ENC_LEFT_A), leftEncoderISR, RISING);
  attachInterrupt(digitalPinToInterrupt(ENC_RIGHT_A), rightEncoderISR, RISING);

  Serial.println("READY");
}

// ===================== MAIN LOOP =====================
void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      inputBuffer.trim();
      processCommand(inputBuffer);
      inputBuffer = "";
    } else {
      inputBuffer += c;
    }
  }

  unsigned long now = millis();

  if (pidMode && (now - lastPIDUpdate >= pidInterval)) {
    float dt = (now - lastPIDUpdate) / 1000.0;
    lastPIDUpdate = now;

    long lt, rt;
    noInterrupts();
    lt = leftTicks;
    rt = rightTicks;
    interrupts();

    // Both wheels positive on forward now (right ISR inverted). No negation.
    float leftActualVel  = (lt - prevLeftTicks) / dt;
    float rightActualVel = (rt - prevRightTicks) / dt;
    prevLeftTicks = lt;
    prevRightTicks = rt;

    // Slew-limit the target the PID chases (firmware-side smooth accel/decel).
    leftRampVel  = slew(leftRampVel,  leftCmdVel);
    rightRampVel = slew(rightRampVel, rightCmdVel);

    leftPWM  = computePID(leftRampVel,  leftActualVel,
                          leftErrorSum,  leftErrorPrev,  leftDerivFilt,  dt);
    rightPWM = computePID(rightRampVel, rightActualVel,
                          rightErrorSum, rightErrorPrev, rightDerivFilt, dt);

    setMotor(M1_PWM, M1_DIR, leftPWM);
    setMotor(M2_PWM, M2_DIR, rightPWM);
  }

  if (now - lastPublish >= publishInterval) {
    lastPublish = now;

    long lt, rt;
    noInterrupts();
    lt = leftTicks;
    rt = rightTicks;
    interrupts();

    Serial.print("E,");
    Serial.print(lt); Serial.print(",");
    Serial.println(rt);
    Serial.print("D,");
    Serial.print(leftPWM); Serial.print(",");
    Serial.println(rightPWM);
  }
}
