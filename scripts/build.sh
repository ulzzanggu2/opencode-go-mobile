#!/bin/sh
# 오픈코드 Go APK 빌드 스크립트 (이 맥 기준 경로)
set -e

export JAVA_HOME="$HOME/jdk/jdk-21.0.13+9/Contents/Home"
export ANDROID_HOME="$HOME/android-sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

cd "$(dirname "$0")/.."

echo "▶ 웹 자산 동기화"
npx cap sync android

echo "▶ 아이콘 생성"
python3 scripts/make_icons.py

echo "▶ APK 빌드"
(cd android && ./gradlew assembleDebug --no-daemon)

APK="android/app/build/outputs/apk/debug/app-debug.apk"
ls -lh "$APK"

if adb devices | grep -q "device$"; then
  echo "▶ 연결된 기기에 설치"
  adb install -r "$APK"
else
  echo "▶ 연결된 기기 없음 — APK를 폰으로 옮겨 직접 설치하세요."
fi
