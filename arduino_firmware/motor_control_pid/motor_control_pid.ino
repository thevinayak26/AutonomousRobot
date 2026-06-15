// PID Motor Control Firmware for Arduino Mega
// Communicates with Pi via raw serial (no rosserial)
// Protocol:
//   Pi sends: "V,leftTicksPerSec,rightTicksPerSec\n" (velocity mode, PID controlled)
//   Pi sends: "M,leftPWM,rightPWM\n" (raw PWM mode, no PID — fallback)
//   Pi sends: "S\n" (stop motors)
//   Pi sends: "R\n" (reset encoders)
//   Arduino sends: "E,leftTicks,rightTicks\n" every 50ms

// Encoder pins
#define ENC_LEFT_A 2
#define ENC_LEFT_B 4
#define ENC_RIGHT_A 3
#define ENC_RIGHT_B 5

// MDD10A motor driver pins
#define M1_PWM 6
#define M1_DIR 7
#define M2_PWM 9
#define M2_DIR 8

// Encoder tick counts
volatile long leftTicks = 0;
volatile long rightTicks = 0;

// Previous ticks for velocity calculation
long prevLeftTicks = 0;
long prevRightTicks = 0;

// PID parameters — tune these on the real robot
float Kp = 0.8;
float Ki = 0.3;
float Kd = 0.05;

// PID state for left motor
float leftError = 0;
float leftErrorSum = 0;
float leftErrorPrev = 0;
int leftPWM = 0;

// PID state for right motor
float rightError = 0;
float rightErrorSum = 0;
float rightErrorPrev = 0;
int rightPWM = 0;

// Target velocities (ticks per second)
float leftTargetVel = 0;
float rightTargetVel = 0;

// Mode: true = PID velocity control, false = raw PWM
bool pidMode = false;

// Timing
unsigned long lastPIDUpdate = 0;
unsigned long lastPublish = 0;
const unsigned long pidInterval = 50;     // PID update every 50ms
const unsigned long publishInterval = 50; // Publish encoder ticks every 50ms

// Anti-windup: limit integral term
const float integralLimit = 500.0;

// Minimum PWM to overcome static friction (tune this)
const int minPWM = 30;

// Serial buffer
String inputBuffer = "";

void leftEncoderISR() {
  if (digitalRead(ENC_LEFT_B) == HIGH)
    leftTicks++;
  else
    leftTicks--;
}

void rightEncoderISR() {
  if (digitalRead(ENC_RIGHT_B) == HIGH)
    rightTicks++;
  else
    rightTicks--;
}

void setMotor(int pwmPin, int dirPin, int speed) {
  // speed: -255 to 255
  if (speed >= 0) {
    digitalWrite(dirPin, LOW);
    analogWrite(pwmPin, constrain(speed, 0, 255));
  } else {
    digitalWrite(dirPin, HIGH);
    analogWrite(pwmPin, constrain(-speed, 0, 255));
  }
}

void stopMotors() {
  leftTargetVel = 0;
  rightTargetVel = 0;
  leftPWM = 0;
  rightPWM = 0;
  leftErrorSum = 0;
  rightErrorSum = 0;
  leftErrorPrev = 0;
  rightErrorPrev = 0;
  setMotor(M1_PWM, M1_DIR, 0);
  setMotor(M2_PWM, M2_DIR, 0);
}

int computePID(float target, float actual, float &errorSum, float &errorPrev, float dt) {
  float error = target - actual;
  
  // Integral with anti-windup
  errorSum += error * dt;
  if (errorSum > integralLimit) errorSum = integralLimit;
  if (errorSum < -integralLimit) errorSum = -integralLimit;
  
  // Derivative
  float errorDeriv = 0;
  if (dt > 0) {
    errorDeriv = (error - errorPrev) / dt;
  }
  errorPrev = error;
  
  // PID output
  float output = (Kp * error) + (Ki * errorSum) + (Kd * errorDeriv);
  
  // Convert to PWM range
  int pwm = (int)output;
  
  // Apply minimum PWM to overcome static friction
  if (target != 0 && pwm > 0 && pwm < minPWM) pwm = minPWM;
  if (target != 0 && pwm < 0 && pwm > -minPWM) pwm = -minPWM;
  
  // If target is zero, allow PWM to be zero (don't force minPWM)
  if (target == 0 && abs(pwm) < minPWM) pwm = 0;
  
  return constrain(pwm, -255, 255);
}

void processCommand(String cmd) {
  if (cmd.startsWith("V,")) {
    // Velocity mode: "V,leftTicksPerSec,rightTicksPerSec"
    int firstComma = cmd.indexOf(',');
    int secondComma = cmd.indexOf(',', firstComma + 1);
    if (secondComma == -1) return;
    
    leftTargetVel = cmd.substring(firstComma + 1, secondComma).toFloat();
    rightTargetVel = cmd.substring(secondComma + 1).toFloat();
    pidMode = true;
  }
  else if (cmd.startsWith("M,")) {
    // Raw PWM mode: "M,leftPWM,rightPWM"
    int firstComma = cmd.indexOf(',');
    int secondComma = cmd.indexOf(',', firstComma + 1);
    if (secondComma == -1) return;
    
    int leftSpeed = cmd.substring(firstComma + 1, secondComma).toInt();
    int rightSpeed = cmd.substring(secondComma + 1).toInt();
    
    pidMode = false;
    leftErrorSum = 0;
    rightErrorSum = 0;
    
    setMotor(M1_PWM, M1_DIR, leftSpeed);
    setMotor(M2_PWM, M2_DIR, rightSpeed);
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
    // Tune PID on the fly: "P,Kp,Ki,Kd"
    int c1 = cmd.indexOf(',');
    int c2 = cmd.indexOf(',', c1 + 1);
    int c3 = cmd.indexOf(',', c2 + 1);
    if (c3 == -1) return;
    
    Kp = cmd.substring(c1 + 1, c2).toFloat();
    Ki = cmd.substring(c2 + 1, c3).toFloat();
    Kd = cmd.substring(c3 + 1).toFloat();
    
    // Reset integral terms when gains change
    leftErrorSum = 0;
    rightErrorSum = 0;
    
    Serial.print("PID,");
    Serial.print(Kp, 3);
    Serial.print(",");
    Serial.print(Ki, 3);
    Serial.print(",");
    Serial.println(Kd, 3);
  }
}

void setup() {
  Serial.begin(115200);
  
  // Motor pins
  pinMode(M1_PWM, OUTPUT);
  pinMode(M1_DIR, OUTPUT);
  pinMode(M2_PWM, OUTPUT);
  pinMode(M2_DIR, OUTPUT);
  analogWrite(M1_PWM, 0);
  analogWrite(M2_PWM, 0);
  
  // Encoder pins
  pinMode(ENC_LEFT_A, INPUT_PULLUP);
  pinMode(ENC_LEFT_B, INPUT);
  pinMode(ENC_RIGHT_A, INPUT_PULLUP);
  pinMode(ENC_RIGHT_B, INPUT);
  
  attachInterrupt(digitalPinToInterrupt(ENC_LEFT_A), leftEncoderISR, RISING);
  attachInterrupt(digitalPinToInterrupt(ENC_RIGHT_A), rightEncoderISR, RISING);
  
  Serial.println("READY");
}

void loop() {
  // Read serial commands
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
  
  // PID update
  if (pidMode && (now - lastPIDUpdate >= pidInterval)) {
    float dt = (now - lastPIDUpdate) / 1000.0; // seconds
    lastPIDUpdate = now;
    
    // Read current ticks
    long lt, rt;
    noInterrupts();
    lt = leftTicks;
    rt = rightTicks;
    interrupts();
    
    // Calculate actual velocity in ticks/sec
    float leftActualVel = (lt - prevLeftTicks) / dt;
    float rightActualVel = (rt - prevRightTicks) / dt;
    prevLeftTicks = lt;
    prevRightTicks = rt;
    
    // Compute PID
    leftPWM = computePID(leftTargetVel, leftActualVel, leftErrorSum, leftErrorPrev, dt);
    rightPWM = computePID(rightTargetVel, rightActualVel, rightErrorSum, rightErrorPrev, dt);
    
    // Apply to motors
    setMotor(M1_PWM, M1_DIR, leftPWM);
    setMotor(M2_PWM, M2_DIR, rightPWM);
  }
  
  // Publish encoder ticks at fixed interval
  if (now - lastPublish >= publishInterval) {
    lastPublish = now;
    
    long lt, rt;
    noInterrupts();
    lt = leftTicks;
    rt = rightTicks;
    interrupts();
    
    Serial.print("E,");
    Serial.print(lt);
    Serial.print(",");
    Serial.println(rt);
  }
}
