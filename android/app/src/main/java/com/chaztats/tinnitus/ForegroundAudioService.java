package com.chaztats.tinnitus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class ForegroundAudioService extends Service {

    public static final String ACTION_START_PLAYBACK = "com.chaztats.tinnitus.action.START_PLAYBACK";
    public static final String ACTION_STOP = "com.chaztats.tinnitus.action.STOP";
    public static final String ACTION_UPDATE_LEVELS = "com.chaztats.tinnitus.action.UPDATE_LEVELS";

    public static final String EXTRA_ASSET_PATH = "assetPath";
    public static final String EXTRA_VOLUME = "volume";
    public static final String EXTRA_PAN = "pan";

    private static final String CHANNEL_ID = "tinnitus_therapy_playback";
    private static final int NOTIFICATION_ID = 1107;
    private MediaPlayer mediaPlayer;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            stopPlayback();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_UPDATE_LEVELS.equals(action)) {
            float volume = intent != null ? intent.getFloatExtra(EXTRA_VOLUME, 1f) : 1f;
            float pan = intent != null ? intent.getFloatExtra(EXTRA_PAN, 0f) : 0f;
            applyLevels(volume, pan);
            return START_STICKY;
        }

        if (ACTION_START_PLAYBACK.equals(action)) {
            String assetPath = intent != null ? intent.getStringExtra(EXTRA_ASSET_PATH) : null;
            float volume = intent != null ? intent.getFloatExtra(EXTRA_VOLUME, 1f) : 1f;
            float pan = intent != null ? intent.getFloatExtra(EXTRA_PAN, 0f) : 0f;

            if (assetPath == null || assetPath.isEmpty()) {
                return START_NOT_STICKY;
            }

            createNotificationChannelIfNeeded();
            startForeground(NOTIFICATION_ID, buildNotification());
            startPlayback(assetPath, volume, pan);
            return START_STICKY;
        }

        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopPlayback();
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent openAppIntent = new Intent(this, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingIntentFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            pendingIntentFlags
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Tinnitus Therapy")
            .setContentText("Therapy playback is active")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void createNotificationChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Therapy Playback",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps tinnitus therapy playback active in background");
        manager.createNotificationChannel(channel);
    }

    private void startPlayback(String assetPath, float volume, float pan) {
        try {
            stopPlayback();

            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            );
            mediaPlayer.setDataSource(this, Uri.parse(assetPath));
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();
            applyLevels(volume, pan);
            mediaPlayer.start();
        } catch (Exception ex) {
            stopPlayback();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private void stopPlayback() {
        if (mediaPlayer == null) {
            return;
        }

        try {
            mediaPlayer.stop();
        } catch (Exception ignored) {
            // Ignore stop errors during cleanup.
        }

        mediaPlayer.release();
        mediaPlayer = null;
    }

    private void applyLevels(float volume, float pan) {
        if (mediaPlayer == null) {
            return;
        }

        float boundedVolume = Math.max(0.001f, Math.min(1f, volume));
        float boundedPan = Math.max(-1f, Math.min(1f, pan));

        float left = boundedPan <= 0f ? boundedVolume : boundedVolume * (1f - boundedPan);
        float right = boundedPan >= 0f ? boundedVolume : boundedVolume * (1f + boundedPan);

        mediaPlayer.setVolume(left, right);
    }
}
