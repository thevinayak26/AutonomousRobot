// PID Motor Control + Ultrasonic Firmware for Arduino Mega
// Communicates with Pi via raw serial (no rosserial)
// Protocol:
//   Pi sends: "V,leftTicksPerSec,rightTicksPerSec\n" (velocity mode, PID controlled)
//   Pi sends: "M,leftPWM,rightPWM\n" (raw PWM mode, no PID — fallback)
//   Pi sends: "S\n" (stop motors)
//   Pi sends: "R\n" (reset encoders)
//   Pi sends: "P,Kp,Ki,Kd\n" (tune PID gains)
//   Arduino sends: "E,leftTicks,rightTicks\n" every 50ms
//   Arduino sends: "U,frontLow,frontMid,frontHigh\n" every 100ms (distances in cm)

// ============ PIN ASSIGNMENTS ============

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

// HC-SR04 Ultrasonic sensor pins
// Sensor 1: Front low (~5cm height) — catches chair legs, floor obstacles
#define US1_TRIG 22
#define US1_ECHO 23

// Sensor 2: Front mid (~15cm height) — LiDAR height redundancy
#define US2_TRIG 24
#define US2_ECHO 25

// Sensor 3: Front high (~30cm height) — catches table edges, shelves
#define US3_TRIG 26
#define US3_ECHO 27

// ============ ENCODER VARIABLES ============

volatile long leftTicks = 0;
volatile long rightTicks = 0;

long prevLeftTicks = 0;
long prevRightTicks = 0;

// ============ PID VARIABLES ============

float Kp = 0.8;
float Ki = 0.3;
float Kd = 0.05;

float leftErrorSum = 0;
float leftErrorPrev = 0;
int leftPWM = 0;

float rightErrorSum = 0;
float rightErrorPrev = 0;
int rightPWM = 0;

float leftTargetVel = 0;
float rightTargetVel = 0;

bool pidMode = false;

const float integralLimit = 500.0;
const int minPWM = 30;

// ============ ULTRASONIC VARIABLES ============

int distFrontLow = 999;   // cm
int distFrontMid = 999;   // cm
int distFrontHigh = 999;  // cm

// Which sensor to read this cycle (round-robin to avoid interference)
int currentSensor = 0;

// ============ TIMING ============

unsigned long lastPIDUpdate = 0;
unsigned long lastPublish = 0;
unsigned long lastUltrasonicRead = 0;
unsigned long lastUltrasonicPublish = 0;

const unsigned long pidInterval = 50;            // PID update every 50ms
const unsigned long publishInterval = 50;        // Encoder publish every 50ms
const unsigned long ultrasonicReadInterval = 35;  // Read one sensor every 35ms (3 sensors = ~105ms full cycle)
const unsigned long ultrasonicPublishInterval = 100; // Publish distances every 100ms

// ============ SERIAL ============

String inputBuffer = "";

// ============ ISR ============

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

// ============ MOTOR CONTROL ============

void setMotor(int pwmPin, int dirPin, int speed) {
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

// ============ PID ============

int computePID(float target, float actual, float &errorSum, float &errorPrev, float dt) {
  float error = target - actual;
  
  errorSum += error * dt;
  if (errorSum > integralLimit) errorSum = integralLimit;
  if (errorSum < -integralLimit) errorSum = -integralLimit;
  
  float errorDeriv = 0;
  if (dt > 0) {
    errorDeriv = (error - errorPrev) / dt;
  }
  errorPrev = error;
  
  float output = (Kp * error) + (Ki * errorSum) + (Kd * errorDeriv);
  int pwm = (int)output;
  
  if (target != 0 && pwm > 0 && pwm < minPWM) pwm = minPWM;
  if (target != 0 && pwm < 0 && pwm > -minPWM) pwm = -minPWM;
  if (target == 0 && abs(pwm) < minPWM) pwm = 0;
  
  return constrain(pwm, -255, 255);
}

// ============ ULTRASONIC ============

int readUltrasonic(int trigPin, int echoPin) {
  // Send 10us trigger pulse
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  // Read echo with timeout (30ms = ~5m max range)
  long duration = pulseIn(echoPin, HIGH, 30000);
  
  if (duration == 0) {
    return 999;  // No echo = nothing in range
  }
  
  // Convert to cm (speed of sound = 343 m/s, divide by 2 for round trip)
  int distance = (int)(duration * 0.0343 / 2.0);
  
  // Clamp to reasonable range
  if (distance < 2) distance = 2;
  if (distance > 400) distance = 999;
  
  return distance;
}

void readNextUltrasonic() {
  switch (currentSensor) {
    case 0:
      distFrontLow = readUltrasonic(US1_TRIG, US1_ECHO);
      break;
    case 1:
      distFrontMid = readUltrasonic(US2_TRIG, US2_ECHO);
      break;
    case 2:
      distFrontHigh = readUltrasonic(US3_TRIG, US3_ECHO);
      break;
  }
  currentSensor = (currentSensor + 1) % 3;
}

// ============ SERIAL COMMANDS ============

void processCommand(String cmd) {
  if (cmd.startsWith("V,")) {
    int firstComma = cmd.indexOf(',');
    int secondComma = cmd.indexOf(',', firstComma + 1);
    if (secondComma == -1) return;
    
    leftTargetVel = cmd.substring(firstComma + 1, secondComma).toFloat();
    rightTargetVel = cmd.substring(secondComma + 1).toFloat();
    pidMode = true;
  }
  else if (cmd.startsWith("M,")) {
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
    int c1 = cmd.indexOf(',');
    int c2 = cmd.indexOf(',', c1 + 1);
    int c3 = cmd.indexOf(',', c2 + 1);
    if (c3 == -1) return;
    
    Kp = cmd.substring(c1 + 1, c2).toFloat();
    Ki = cmd.substring(c2 + 1, c3).toFloat();
    Kd = cmd.substring(c3 + 1).toFloat();
    
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

// ============ SETUP ============

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
  
  // Ultrasonic pins
  pinMode(US1_TRIG, OUTPUT);
  pinMode(US1_ECHO, INPUT);
  pinMode(US2_TRIG, OUTPUT);
  pinMode(US2_ECHO, INPUT);
  pinMode(US3_TRIG, OUTPUT);
  pinMode(US3_ECHO, INPUT);
  
  Serial.println("READY");
}

// ============ MAIN LOOP ============

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
    float dt = (now - lastPIDUpdate) / 1000.0;
    lastPIDUpdate = now;
    
    long lt, rt;
    noInterrupts();
    lt = leftTicks;
    rt = rightTicks;
    interrupts();
    
    float leftActualVel = (lt - prevLeftTicks) / dt;
    float rightActualVel = (rt - prevRightTicks) / dt;
    prevLeftTicks = lt;
    prevRightTicks = rt;
    
    leftPWM = computePID(leftTargetVel, leftActualVel, leftErrorSum, leftErrorPrev, dt);
    rightPWM = computePID(rightTargetVel, rightActualVel, rightErrorSum, rightErrorPrev, dt);
    
    setMotor(M1_PWM, M1_DIR, leftPWM);
    setMotor(M2_PWM, M2_DIR, rightPWM);
  }
  
  // Read one ultrasonic sensor per cycle (round-robin)
  if (now - lastUltrasonicRead >= ultrasonicReadInterval) {
    lastUltrasonicRead = now;
    readNextUltrasonic();
  }
  
  // Publish encoder ticks
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
  
  // Publish ultrasonic distances
  if (now - lastUltrasonicPublish >= ultrasonicPublishInterval) {
    lastUltrasonicPublish = now;
    
    Serial.print("U,");
    Serial.print(distFrontLow);
    Serial.print(",");
    Serial.print(distFrontMid);
    Serial.print(",");
    Serial.println(distFrontHigh);
  }
}
