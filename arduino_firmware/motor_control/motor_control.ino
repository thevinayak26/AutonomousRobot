// Motor Control Firmware for Arduino Mega
// Communicates with Pi via raw serial (no rosserial)
// Protocol:
//   Pi sends: "M,leftPWM,rightPWM\n" (e.g., "M,150,-150\n")
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

// Timing
unsigned long lastPublish = 0;
const unsigned long publishInterval = 50; // ms

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

void processCommand(String cmd) {
  // Expected format: "M,leftPWM,rightPWM"
  if (cmd.startsWith("M,")) {
    int firstComma = cmd.indexOf(',');
    int secondComma = cmd.indexOf(',', firstComma + 1);
    if (secondComma == -1) return;
    
    int leftSpeed = cmd.substring(firstComma + 1, secondComma).toInt();
    int rightSpeed = cmd.substring(secondComma + 1).toInt();
    
    setMotor(M1_PWM, M1_DIR, leftSpeed);
    setMotor(M2_PWM, M2_DIR, rightSpeed);
  }
  else if (cmd.startsWith("S")) {
    // Stop command
    setMotor(M1_PWM, M1_DIR, 0);
    setMotor(M2_PWM, M2_DIR, 0);
  }
  else if (cmd.startsWith("R")) {
    // Reset encoders
    noInterrupts();
    leftTicks = 0;
    rightTicks = 0;
    interrupts();
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
  
  // Publish encoder ticks at fixed interval
  unsigned long now = millis();
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
