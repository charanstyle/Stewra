const {
  withAndroidManifest,
  withDangerousMod,
  withAppBuildGradle,
  withMainApplication,
} = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

// Ported and adapted from TrueTalk's frontend/plugins/withAndroidNotificationAvatar.cjs
// (package renamed com.nurturinglab.truetalk -> com.stewra.app, scheme
// truetalk -> stewra; `callerAvatarUrl` dropped throughout — Stewra's
// PublicUser model has no avatar field).
//
// Custom FirebaseMessagingService that handles Stewra's FCM data messages.
// It replaces Expo's default ExpoFirebaseMessagingService, so it must handle
// every notification type.
//
// Incoming calls are NOT rendered inline here: a high-priority FCM data message
// with `type=incoming_call` (sent by the backend's call-push service) is handed
// off to IncomingCallRingService (below), a foreground service that plays a
// looping system ringtone + vibration and posts a full-screen CallStyle
// notification, so the device rings continuously (CallKit-equivalent) even
// when the app was killed.
//
// The two payload shapes this service receives:
//   - Call pushes: FLAT data keys — type, callId, conversationId, callKind,
//       callerName
//   - Message pushes: data["title"], data["message"], data["body"] (JSON:
//       conversationId), data["badge"]
const KOTLIN_SOURCE = `package com.stewra.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.*
import org.json.JSONObject

class StewraMessagingService : FirebaseMessagingService() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        private const val CHANNEL_ID = "messages"
        private const val CHANNEL_NAME = "Messages"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        try {
            val delegateClass = Class.forName(
                "expo.modules.notifications.service.delegates.FirebaseMessagingDelegate"
            )
            val constructor = delegateClass.getDeclaredConstructor(Context::class.java)
            val delegate = constructor.newInstance(this)
            val method = delegateClass.getMethod("onNewToken", String::class.java)
            method.invoke(delegate, token)
        } catch (_: Exception) {
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        val data = remoteMessage.data
        if (data.isEmpty()) return

        // Incoming call (flat data payload from the backend's call-push
        // service): type=incoming_call, callId, conversationId, callKind,
        // callerName. Hand off to the foreground ring service, which owns
        // the looping ringtone, vibration and full-screen call notification and
        // keeps the process alive for the whole ring so a later call_cancelled
        // push (or a JS answer/decline via IncomingCallRing) can stop it.
        when (data["type"]) {
            "incoming_call" -> {
                startRingService(data)
                return
            }
            "call_cancelled" -> {
                stopRingService()
                return
            }
        }

        val title = data["title"] ?: return
        val message = data["message"] ?: ""

        var conversationId: String? = null

        val bodyJson = data["body"]
        if (bodyJson != null) {
            try {
                val json = JSONObject(bodyJson)
                conversationId = json.optString("conversationId", "").takeIf { it.isNotEmpty() }
            } catch (_: Exception) {
            }
        }

        val badgeCount = data["badge"]?.toIntOrNull() ?: 0
        val finalConversationId = conversationId

        serviceScope.launch {
            withContext(Dispatchers.Main) {
                showNotification(title, message, finalConversationId, badgeCount)
            }
        }
    }

    // Start the foreground ring service for an incoming call, forwarding every
    // FCM data key as an intent extra (the service reads callId, callKind,
    // callerName, conversationId).
    private fun startRingService(data: Map<String, String>) {
        val intent = Intent().apply {
            setClassName(packageName, "$packageName.IncomingCallRingService")
            action = IncomingCallRingService.ACTION_START
            for ((key, value) in data) {
                putExtra(key, value)
            }
        }
        ContextCompat.startForegroundService(this, intent)
    }

    private fun stopRingService() {
        // Only deliver a stop when a ring is actually active. While ringing the
        // service is foreground (process is foreground), so startService is
        // allowed; if nothing is ringing there is nothing to stop.
        if (!IncomingCallRingService.isRunning) return
        val intent = Intent().apply {
            setClassName(packageName, "$packageName.IncomingCallRingService")
            action = IncomingCallRingService.ACTION_STOP
        }
        startService(intent)
    }

    private fun showNotification(
        title: String,
        body: String,
        conversationId: String?,
        badgeCount: Int
    ) {
        ensureNotificationChannel()

        val intent = if (conversationId != null) {
            Intent(Intent.ACTION_VIEW, Uri.parse("stewra://conversation/$conversationId")).apply {
                setClassName(packageName, "$packageName.MainActivity")
            }
        } else {
            Intent(this, MainActivity::class.java)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        val pendingIntent = PendingIntent.getActivity(
            this,
            System.currentTimeMillis().toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
            .setNumber(badgeCount)

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notificationId = conversationId?.hashCode() ?: System.currentTimeMillis().toInt()
        manager.notify(notificationId, builder.build())
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Message notifications from Stewra"
                    enableVibration(true)
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }
}
`;

// Foreground service that rings for an incoming call: a looping system ringtone
// + repeating vibration (both honouring the device ringer mode) plus a
// full-screen-intent CallStyle notification that opens the in-app answer UI. It
// is started by StewraMessagingService on an incoming_call FCM (works even
// when the app was killed — a high-priority FCM grants the background FGS-start
// exemption) and by the JS IncomingCallRing module on the foreground/socket
// path. It stops on a call_cancelled FCM, a JS answer/decline, a self-timeout,
// or the Android 14 shortService watchdog.
const RING_SERVICE_SOURCE = `package com.stewra.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

class IncomingCallRingService : Service() {

    companion object {
        const val ACTION_START = "com.stewra.app.action.RING_START"
        const val ACTION_STOP = "com.stewra.app.action.RING_STOP"
        private const val CHANNEL_ID = "incoming_call_ring"
        private const val NOTIFICATION_ID = 424242
        // Mirrors the backend's call-signaling ring timeout.
        private const val RING_TIMEOUT_MS = 60000L
        // App deep-link scheme (app.config.ts "scheme": "stewra").
        private const val SCHEME = "stewra"
        private const val TAG = "StewraRing"

        // Shared store for the currently-ringing call. The IncomingCallRing
        // native module (IncomingCallRingModule, generated into this same app
        // package by this plugin) reads these keys via getPendingCall() to
        // render the in-app answer UI on a killed-app cold start. Android
        // deep-link delivery to JS is unreliable when the app is launched from a
        // dead process, so the service — always started reliably by the
        // high-priority FCM — is the source of truth instead. Same package =>
        // same prefs file.
        const val PENDING_PREFS = "incoming_call_pending"
        // The keys mirror the VoipCallPushPayload / FCM data contract.
        private val PENDING_KEYS = listOf(
            "callId",
            "conversationId",
            "callKind",
            "callerName"
        )

        // Same-process flag so the FCM service / JS bridge only deliver a STOP
        // when a ring is actually active (a STOP would otherwise spin the service
        // up just to tear it down, and risk a background-start violation).
        @Volatile
        var isRunning = false
            private set
    }

    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var currentCallId: String? = null
    private val timeoutHandler = Handler(Looper.getMainLooper())
    private val timeoutRunnable = Runnable {
        Log.i(TAG, "ring timeout reached, stopping")
        stopEverything()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> handleStart(intent)
            else -> stopEverything()
        }
        return START_NOT_STICKY
    }

    private fun handleStart(intent: Intent) {
        val callId = intent.getStringExtra("callId") ?: ""

        // Dedup: the same call can arrive via FCM (killed app) and again via the
        // JS socket path. Keep the first ring; ignore repeats for that call.
        if (isRunning && callId.isNotEmpty() && callId == currentCallId) {
            return
        }

        currentCallId = callId
        isRunning = true

        // Persist the call so JS can pick it up on a killed-app cold start
        // (see PENDING_PREFS). Cleared in stopEverything().
        savePendingCall(intent)

        val title = intent.getStringExtra("callerName")?.takeIf { it.isNotEmpty() }
            ?: "Incoming call"
        val message = if (intent.getStringExtra("callKind") == "video") {
            "Incoming video call"
        } else {
            "Incoming call"
        }

        // Promote to a foreground service immediately (within the start window).
        ensureChannel()
        startForegroundCompat(buildNotification(title, message, intent))

        startRinging()

        // Safety net: never ring forever if no stop signal arrives.
        timeoutHandler.removeCallbacks(timeoutRunnable)
        timeoutHandler.postDelayed(timeoutRunnable, RING_TIMEOUT_MS)
    }

    private fun buildNotification(
        title: String,
        message: String,
        source: Intent
    ): Notification {
        // Answer: open the in-app call UI (deep link into MainActivity).
        val answerActivity = Intent(Intent.ACTION_VIEW, buildDeepLinkUri(source)).apply {
            setClassName(packageName, "$packageName.MainActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val answerIntent = PendingIntent.getActivity(
            this,
            0,
            answerActivity,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Decline: deliver ACTION_STOP to this service to silence the ring. The
        // service is foreground while ringing, so a getService start is allowed.
        val declineService = Intent().apply {
            setClassName(packageName, "$packageName.IncomingCallRingService")
            action = ACTION_STOP
        }
        val declineIntent = PendingIntent.getService(
            this,
            1,
            declineService,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val caller = Person.Builder()
            .setName(title)
            .setImportant(true)
            .build()

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(answerIntent)
            // CallStyle is the only reliable incoming-call presentation on modern
            // Android: a plain CATEGORY_CALL notification gets swept into a
            // silent alerting-section bundle when the device is unlocked (the
            // full-screen intent only auto-launches while locked, so there is
            // otherwise nothing visible). CallStyle notifications are exempt
            // from that auto-bundling, rank at the top, and show prominent
            // Answer / Decline actions.
            .setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    caller,
                    declineIntent,
                    answerIntent
                )
            )
            // Still request full-screen so the call UI launches directly over the
            // lock screen / when the app was killed.
            .setFullScreenIntent(answerIntent, true)

        return builder.build()
    }

    private fun savePendingCall(intent: Intent) {
        val prefs = getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
        val editor = prefs.edit()
        editor.clear()
        for (key in PENDING_KEYS) {
            editor.putString(key, intent.getStringExtra(key) ?: "")
        }
        editor.apply()
    }

    private fun clearPendingCall() {
        getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }

    private fun buildDeepLinkUri(source: Intent): Uri {
        val builder = Uri.Builder().scheme(SCHEME).authority("call")
        source.extras?.keySet()?.forEach { key ->
            builder.appendQueryParameter(key, source.getStringExtra(key) ?: "")
        }
        return builder.build()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startRinging() {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        when (audioManager.ringerMode) {
            AudioManager.RINGER_MODE_SILENT -> return
            AudioManager.RINGER_MODE_VIBRATE -> startVibration()
            else -> {
                startVibration()
                startRingtone()
            }
        }
    }

    private fun startRingtone() {
        try {
            val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: return
            mediaPlayer = MediaPlayer().apply {
                setDataSource(this@IncomingCallRingService, uri)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            Log.e(TAG, "ringtone start failed: " + e.message)
        }
    }

    private fun startVibration() {
        val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator = vib
        // wait 0ms, buzz 1s, pause 1s — repeat from index 0.
        val pattern = longArrayOf(0, 1000, 1000)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vib.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vib.vibrate(pattern, 0)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Incoming calls",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Ringing for incoming calls"
                    // The foreground service owns audio + vibration, so the
                    // channel stays silent to avoid a double ring.
                    setSound(null, null)
                    enableVibration(false)
                }
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun stopEverything() {
        timeoutHandler.removeCallbacks(timeoutRunnable)
        try {
            mediaPlayer?.stop()
        } catch (_: Exception) {
        }
        mediaPlayer?.release()
        mediaPlayer = null
        vibrator?.cancel()
        vibrator = null
        isRunning = false
        currentCallId = null
        clearPendingCall()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    // Android 14 shortService watchdog: stop cleanly if the ring ever reaches the
    // service time limit (our own timeout fires well before this).
    override fun onTimeout(startId: Int) {
        stopEverything()
    }
}
`;

// JS bridge to IncomingCallRingService, generated into the app package (not a
// checked-in native module — the repo keeps android & ios fully regenerated by
// prebuild). Lets the foreground/socket JS flow start the same ring the FCM
// handler starts when the app is killed, stop it on answer/decline, and read
// the currently-ringing call on a killed-app cold start (where Android
// deep-link delivery to JS is unreliable). iOS has no native counterpart —
// CallKit owns incoming calls there — so the JS layer no-ops on iOS.
const BRIDGE_MODULE_SOURCE = `package com.stewra.app

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap

class IncomingCallRingModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val SERVICE_CLASS = "com.stewra.app.IncomingCallRingService"
        private const val ACTION_START = "com.stewra.app.action.RING_START"
        private const val ACTION_STOP = "com.stewra.app.action.RING_STOP"
        // Must match IncomingCallRingService.PENDING_PREFS / PENDING_KEYS.
        private const val PENDING_PREFS = "incoming_call_pending"
        private val PENDING_KEYS = listOf(
            "callId",
            "conversationId",
            "callKind",
            "callerName"
        )
    }

    override fun getName(): String = "IncomingCallRing"

    @ReactMethod
    fun startRing(payload: ReadableMap) {
        val intent = Intent().apply {
            setClassName(reactContext.packageName, SERVICE_CLASS)
            action = ACTION_START
            val iterator = payload.keySetIterator()
            while (iterator.hasNextKey()) {
                val key = iterator.nextKey()
                putExtra(key, payload.getString(key) ?: "")
            }
        }
        ContextCompat.startForegroundService(reactContext, intent)
    }

    @ReactMethod
    fun stopRing() {
        // Only deliver a stop when a ring is actually active: a stale stop would
        // otherwise spin the service up just to tear it down (and risk a
        // background-start violation).
        if (!IncomingCallRingService.isRunning) return
        val intent = Intent().apply {
            setClassName(reactContext.packageName, SERVICE_CLASS)
            action = ACTION_STOP
        }
        reactContext.startService(intent)
    }

    // Android 14 (API 34) revokes USE_FULL_SCREEN_INTENT from non-calling apps by
    // default; without it a killed/locked-device incoming call cannot auto-launch
    // the full-screen call UI (it degrades to a heads-up notification). Expose the
    // grant state + a way to send the user to the system grant screen.
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun canUseFullScreenIntent(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return manager.canUseFullScreenIntent()
    }

    @ReactMethod
    fun requestFullScreenIntentPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
        val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
            data = Uri.parse("package:" + reactContext.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
    }

    // Synchronous so the JS layer can read the pending call inline on mount /
    // app-foreground and surface the answer UI without an async round-trip.
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getPendingCall(): WritableMap? {
        val prefs = reactContext.getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
        val callId = prefs.getString("callId", "") ?: ""
        if (callId.isEmpty()) return null
        val map = Arguments.createMap()
        for (key in PENDING_KEYS) {
            map.putString(key, prefs.getString(key, "") ?: "")
        }
        return map
    }
}
`;

// ReactPackage that registers IncomingCallRingModule. Added to MainApplication's
// package list by registerCallRingPackage() below.
const BRIDGE_PACKAGE_SOURCE = `package com.stewra.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class IncomingCallRingPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(IncomingCallRingModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
`;

/**
 * Write the Kotlin source files into the android project during prebuild.
 */
function writeKotlinSource(config) {
  const androidPath = config.modRequest.platformProjectRoot;
  const packageDir = path.join(androidPath, 'app', 'src', 'main', 'java', 'com', 'stewra', 'app');

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'StewraMessagingService.kt'), KOTLIN_SOURCE);
  fs.writeFileSync(path.join(packageDir, 'IncomingCallRingService.kt'), RING_SERVICE_SOURCE);
  fs.writeFileSync(path.join(packageDir, 'IncomingCallRingModule.kt'), BRIDGE_MODULE_SOURCE);
  fs.writeFileSync(path.join(packageDir, 'IncomingCallRingPackage.kt'), BRIDGE_PACKAGE_SOURCE);

  return config;
}

/**
 * Register IncomingCallRingPackage in MainApplication's getPackages(). The
 * bridge is a plain React Native module (not Expo-autolinked), so it must be
 * added manually. Same package as MainApplication => no import needed.
 */
function registerCallRingPackage(config) {
  let contents = config.modResults.contents;

  if (contents.includes('IncomingCallRingPackage()')) {
    return config; // idempotent
  }

  const anchor = 'PackageList(this).packages.apply {';
  if (!contents.includes(anchor)) {
    throw new Error(
      'withAndroidNotificationAvatar: could not find PackageList(...).apply { ' +
        'in MainApplication.kt; cannot register IncomingCallRingPackage.'
    );
  }

  contents = contents.replace(
    anchor,
    `${anchor}\n              add(IncomingCallRingPackage())`
  );
  config.modResults.contents = contents;
  return config;
}

/**
 * Register custom service + ring service, and remove Expo's default in
 * AndroidManifest.xml.
 */
function modifyManifest(config) {
  const manifest = config.modResults;
  const application = manifest.manifest.application?.[0];
  if (!application) {
    throw new Error('withAndroidNotificationAvatar: no <application> in AndroidManifest');
  }

  // The tools namespace is required for tools:node="remove" below.
  manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

  if (!application.service) {
    application.service = [];
  }

  // expo-notifications registers ExpoFirebaseMessagingService via its AAR
  // library manifest, so a JS array filter on the app's source manifest can't
  // remove it — the manifest merger re-adds the library copy, and it wins the
  // race for com.google.firebase.MESSAGING_EVENT. Emit a tools:node="remove"
  // stub so the merger deletes the library-provided service entirely, leaving
  // only our StewraMessagingService to receive FCM messages.
  application.service = application.service.filter((service) => {
    const name = service.$?.['android:name'] || '';
    return !name.includes('ExpoFirebaseMessagingService');
  });

  application.service.push({
    $: {
      'android:name':
        'expo.modules.notifications.service.ExpoFirebaseMessagingService',
      'tools:node': 'remove',
    },
  });

  // Idempotent: drop any previous registration of our services before re-adding.
  application.service = application.service.filter((service) => {
    const name = service.$?.['android:name'] || '';
    return (
      !name.includes('StewraMessagingService') &&
      !name.includes('IncomingCallRingService')
    );
  });

  application.service.push({
    $: {
      'android:name': '.StewraMessagingService',
      'android:exported': 'false',
    },
    'intent-filter': [
      {
        action: [
          {
            $: {
              'android:name': 'com.google.firebase.MESSAGING_EVENT',
            },
          },
        ],
      },
    ],
  });

  // shortService: a high-priority FCM grants a temporary background FGS-start
  // exemption and shortService needs no use-case role (unlike phoneCall), while
  // its ~3-min cap comfortably covers a 60s ring.
  application.service.push({
    $: {
      'android:name': '.IncomingCallRingService',
      'android:exported': 'false',
      'android:foregroundServiceType': 'shortService',
    },
  });

  return config;
}

/**
 * Add firebase-messaging dependency to app/build.gradle.
 */
function addFirebaseDependency(config) {
  let buildGradle = config.modResults.contents;

  const bom = 'implementation platform("com.google.firebase:firebase-bom:33.7.0")';
  const messaging = 'implementation "com.google.firebase:firebase-messaging"';

  if (!buildGradle.includes('firebase-messaging')) {
    // Insert after the first "dependencies {" line
    buildGradle = buildGradle.replace(
      /dependencies\s*\{/,
      `dependencies {\n    ${bom}\n    ${messaging}`
    );
    config.modResults.contents = buildGradle;
  }

  return config;
}

module.exports = function withAndroidNotificationAvatar(appConfig) {
  appConfig = withDangerousMod(appConfig, ['android', writeKotlinSource]);
  appConfig = withAndroidManifest(appConfig, modifyManifest);
  appConfig = withAppBuildGradle(appConfig, addFirebaseDependency);
  appConfig = withMainApplication(appConfig, registerCallRingPackage);
  return appConfig;
};
