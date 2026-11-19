package com.odin.overlay

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.graphics.drawable.GradientDrawable
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import org.json.JSONObject

class OdinOverlayService : Service() {
  companion object {
    const val ACTION_START = "com.odin.overlay.START"
    const val ACTION_STOP_TRACKING = "com.odin.overlay.STOP_TRACKING"
    const val PREFERENCES = "odin_overlay_preferences"
    const val CONFIG_JSON = "config_json"
    const val PENDING_TRIGGER = "pending_trigger"
    const val ACTIVE_ALERT_ID = "active_alert_id"
    private const val CHANNEL_ID = "odin-overlay"
    private const val NOTIFICATION_ID = 4407
    private const val HOLD_MS = 1500L
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private var windowManager: WindowManager? = null
  private var bubble: FrameLayout? = null
  private var bubbleParams: WindowManager.LayoutParams? = null
  private var isHolding = false
  private var longPressTriggered = false
  private var dragged = false
  private var downRawX = 0f
  private var downRawY = 0f
  private var downWindowX = 0
  private var downWindowY = 0
  private var lastTapAt = 0L
  private var progressBar: ProgressBar? = null
  private val progressRunnable = object : Runnable {
    override fun run() {
      if (!isHolding || longPressTriggered) return
      val elapsed = System.currentTimeMillis() - holdStartedAt
      progressBar?.progress = ((elapsed.toDouble() / HOLD_MS.toDouble()) * 100.0).toInt().coerceIn(0, 100)
      mainHandler.postDelayed(this, 40L)
    }
  }
  private var holdStartedAt = 0L
  private var sending = false
  private var locationManager: LocationManager? = null
  private var locationListener: LocationListener? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    locationManager = getSystemService(LocationManager::class.java)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP_TRACKING -> stopNativeTracking()
      else -> {
        startForeground(NOTIFICATION_ID, buildNotification())
        showBubbleSafely()
        val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val activeAlertId = preferences.getString(ACTIVE_ALERT_ID, null)
        val rawConfig = preferences.getString(CONFIG_JSON, null)
        if (!activeAlertId.isNullOrBlank() && !rawConfig.isNullOrBlank()) {
          try { startNativeTracking(JSONObject(rawConfig), activeAlertId) } catch (_: Exception) { }
        }
      }
    }
    return START_STICKY
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Atalho discreto", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Mantém o atalho de assistência disponível"
      setShowBadge(false)
    })
  }

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launchIntent?.let { PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()) }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("Atalho de assistência ativo")
        .setContentText("Toque longo no botão flutuante para pedir ajuda")
        .setCategory(Notification.CATEGORY_SERVICE)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setContentIntent(pending)
        .setOngoing(true)
        .build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("Atalho de assistência ativo")
        .setContentText("Toque longo no botão flutuante para pedir ajuda")
        .setOngoing(true)
        .build()
    }
  }

  private fun immutableFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

  private fun showBubbleSafely() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
      stopSelf()
      return
    }
    if (bubble != null) return
    try {
      windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
      val root = FrameLayout(this).apply {
        background = GradientDrawable().apply {
          shape = GradientDrawable.OVAL
          setColor(Color.rgb(53, 68, 74))
          setStroke(2, Color.rgb(106, 119, 122))
        }
        elevation = 10f
      }
      val label = TextView(this).apply {
        text = "•"
        textSize = 30f
        setTextColor(Color.rgb(248, 248, 244))
        gravity = Gravity.CENTER
      }
      root.addView(label, FrameLayout.LayoutParams(-1, -1))
      val progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
        max = 100
        progress = 0
        progressDrawable = GradientDrawable().apply { setColor(Color.rgb(212, 154, 58)) }
      }
      progressBar = progress
      val progressParams = FrameLayout.LayoutParams(-1, 5, Gravity.BOTTOM).apply { leftMargin = 9; rightMargin = 9; bottomMargin = 7 }
      root.addView(progress, progressParams)
      root.setOnTouchListener { _, event -> onBubbleTouch(event) }
      bubble = root
      val windowType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
      bubbleParams = WindowManager.LayoutParams(
        72,
        72,
        windowType,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.TOP or Gravity.END
        x = 18
        y = 260
      }
      windowManager?.addView(root, bubbleParams)
    } catch (_: Exception) {
      bubble = null
      stopSelf()
    }
  }

  private fun onBubbleTouch(event: MotionEvent): Boolean {
    val params = bubbleParams ?: return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        isHolding = true
        longPressTriggered = false
        dragged = false
        holdStartedAt = System.currentTimeMillis()
        downRawX = event.rawX
        downRawY = event.rawY
        downWindowX = params.x
        downWindowY = params.y
        mainHandler.post(progressRunnable)
        mainHandler.postDelayed({
          if (isHolding && !dragged) {
            longPressTriggered = true
            triggerEmergencyWithoutOpeningUi()
          }
        }, HOLD_MS)
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = (event.rawX - downRawX).toInt()
        val dy = (event.rawY - downRawY).toInt()
        if (kotlin.math.abs(dx) > 8 || kotlin.math.abs(dy) > 8) {
          dragged = true
          isHolding = false
          mainHandler.removeCallbacksAndMessages(null)
          params.x = (downWindowX - dx).coerceAtLeast(0)
          params.y = (downWindowY + dy).coerceAtLeast(0)
          try { windowManager?.updateViewLayout(bubble, params) } catch (_: Exception) { }
        }
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val wasShortTap = !dragged && !longPressTriggered && event.actionMasked == MotionEvent.ACTION_UP
        isHolding = false
        mainHandler.removeCallbacksAndMessages(null)
        progressBar?.progress = 0
        if (wasShortTap) {
          val now = System.currentTimeMillis()
          if (now - lastTapAt < 350L) {
            openAppOnlyOnDoubleTap()
            lastTapAt = 0L
          } else {
            lastTapAt = now
          }
        }
        return true
      }
    }
    return true
  }

  private fun triggerEmergencyWithoutOpeningUi() {
    val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    preferences.edit().putBoolean(PENDING_TRIGGER, true).apply()
    if (sending) return
    val rawConfig = preferences.getString(CONFIG_JSON, null) ?: return
    val config = try { JSONObject(rawConfig) } catch (_: Exception) { return }
    if (config.optString("apiBaseUrl").isBlank() || config.optString("deviceId").isBlank() || config.optString("deviceToken").isBlank()) return
    sending = true
    Thread {
      val alertId = "alert_${UUID.randomUUID()}"
      val location = lastKnownLocation()
      val payload = JSONObject().apply {
        put("alertId", alertId)
        put("driverDeviceId", config.optString("deviceId"))
        put("driverName", config.optString("driverName", "Motorista"))
        put("vehicle", config.optJSONObject("vehicle") ?: JSONObject())
        put("location", location?.let { JSONObject().put("latitude", it.latitude).put("longitude", it.longitude) })
        put("locationSource", if (location != null) "last" else "none")
        put("capturedAt", java.time.Instant.now().toString())
      }
      val ok = postJson(config.optString("apiBaseUrl") + "/api/alert/trigger", config.optString("deviceToken"), payload)
      if (ok) {
        preferences.edit().putBoolean(PENDING_TRIGGER, false).putString(ACTIVE_ALERT_ID, alertId).apply()
        startNativeTracking(config, alertId)
      }
      sending = false
    }.start()
  }

  private fun openAppOnlyOnDoubleTap() {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return
    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    try { startActivity(launchIntent) } catch (_: Exception) { }
  }

  private fun lastKnownLocation(): Location? {
    val manager = locationManager ?: return null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null
    val candidates = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).mapNotNull { provider -> try { manager.getLastKnownLocation(provider) } catch (_: Exception) { null } }
    return candidates.minByOrNull { it.accuracy }
  }

  private fun startNativeTracking(config: JSONObject, alertId: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
    stopNativeTracking()
    val manager = locationManager ?: return
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        Thread {
          val payload = JSONObject().apply {
            put("driverDeviceId", config.optString("deviceId"))
            put("alertId", alertId)
            put("latitude", location.latitude)
            put("longitude", location.longitude)
            put("capturedAt", java.time.Instant.ofEpochMilli(location.time).toString())
          }
          postJson(config.optString("apiBaseUrl") + "/api/alert/location", config.optString("deviceToken"), payload)
        }.start()
      }
    }
    locationListener = listener
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      try { if (manager.isProviderEnabled(provider)) manager.requestLocationUpdates(provider, 5000L, 10f, listener, Looper.getMainLooper()) } catch (_: Exception) { }
    }
  }

  private fun stopNativeTracking() {
    val listener = locationListener ?: return
    try { locationManager?.removeUpdates(listener) } catch (_: Exception) { }
    locationListener = null
    getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().remove(ACTIVE_ALERT_ID).apply()
  }

  private fun postJson(endpoint: String, token: String, payload: JSONObject): Boolean {
    return try {
      val connection = URL(endpoint.trimEnd('/')).openConnection() as HttpURLConnection
      connection.requestMethod = "POST"
      connection.connectTimeout = 8000
      connection.readTimeout = 8000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("X-Device-Token", token)
      connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      connection.disconnect()
      code in 200..299
    } catch (_: Exception) {
      false
    }
  }

  override fun onDestroy() {
    mainHandler.removeCallbacksAndMessages(null)
    stopNativeTracking()
    try { bubble?.let { windowManager?.removeView(it) } } catch (_: Exception) { }
    bubble = null
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    // START_STICKY lets Android recreate the service without ever launching the app UI.
  }
}
