# Tinnitus Therapy Mobile Native Setup

This project is now configured for Capacitor with Android and iOS platforms.

## What was added

- Capacitor project initialization:
  - appId: com.chaztats.tinnitus
  - appName: Tinnitus Therapy
  - webDir: www
- Native platforms:
  - android/
  - ios/
- iOS background audio setup:
  - Info.plist: UIBackgroundModes includes audio
  - AppDelegate.swift: AVAudioSession category configured for playback
- Android media playback-related permissions:
  - WAKE_LOCK
  - FOREGROUND_SERVICE
  - FOREGROUND_SERVICE_MEDIA_PLAYBACK
- NPM scripts for mobile workflow in package.json
- In-app diagnostics panel:
  - Playback Diagnostics card shows visibility and audio state logs
  - Copy Logs action for sharing test traces

## Commands

### Build web and sync native projects

npm run build:mobile

### Sync only

npm run cap:sync

### Copy only

npm run cap:copy

### Open native projects

npm run cap:open:android
npm run cap:open:ios

### Run directly from CLI

npm run cap:run:android
npm run cap:run:ios

## Android checklist

1. Open Android Studio:
   - npm run cap:open:android
2. Wait for Gradle sync to complete.
3. Connect a device and enable USB debugging.
4. Build and run from Android Studio.
5. Test lock-screen/background audio:
   - Start therapy.
   - Turn the screen off.
   - Verify sound continues.
   - Verify media controls appear in lock screen/notification shade.

Notes:

- Behavior can vary by OEM battery optimization policies.
- If playback is killed in background, disable battery optimization for the app while testing.

### Play Store versioning

Use manual versioning in `android/app/build.gradle`.

- Increase `versionCode` for every Play Console upload.
- Update `versionName` as desired for release labeling.

## iOS checklist

1. Use macOS with Xcode.
2. Open Xcode project:
   - npm run cap:open:ios
3. In Signing & Capabilities:
   - Set Team and Bundle Identifier.
4. In Background Modes:
   - Ensure Audio, AirPlay, and Picture in Picture is enabled.
5. Build and run on a physical iPhone.
6. Test lock-screen/background audio:
   - Start therapy.
   - Lock screen.
   - Verify sound continues.
   - Verify lock-screen media controls are shown.

## Important caveat for generated WebAudio

This app generates sound with WebAudio in a WebView. The native settings above are required, but some device/OS combinations may still throttle or suspend background execution over long periods.

If you need guaranteed long-duration playback reliability, move synthesis to a native audio engine (Android AudioTrack/ExoPlayer service and iOS AVAudioEngine) via a Capacitor plugin, and keep the Angular UI as control surface.

## Typical development cycle

1. Edit Angular code.
2. Run: npm run build:mobile
3. Open native project (Android Studio/Xcode).
4. Deploy to real device and validate lock-screen behavior.
5. Repeat.

## Diagnostics quick use

1. Start therapy.
2. Scroll to Playback Diagnostics.
3. Lock/unlock screen or switch apps.
4. Return to the app and inspect log entries.
5. Use Copy Logs to paste traces into bug reports.

## Ionic Appflow iOS build fix (Capacitor 8 SPM)

If Appflow fails with:

- No .xcworkspace found at ios/App/App.xcworkspace
- Detected IOS_PACKAGE_MANAGER=:cocoapods

then Appflow is trying to build with CocoaPods, but this project uses Swift Package Manager.

Set these Appflow environment variables for the iOS build:

- ENABLE_SPM_SUPPORT=true
- IOS_PACKAGE_MANAGER=spm

Where to set them:

1. Appflow dashboard -> App -> Build settings -> Environment variables.
2. Add the two keys above for the target build stack/environment.
3. Re-run the iOS build.

Quick verification:

- iOS folder contains App.xcodeproj and CapApp-SPM.
- There is no App.xcworkspace and no Podfile in ios/App for this project.
