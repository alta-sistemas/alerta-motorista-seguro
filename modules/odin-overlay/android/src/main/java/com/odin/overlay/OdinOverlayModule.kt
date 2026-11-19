package com.odin.overlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OdinOverlayModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OdinOverlay")

    Function("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
    }

    Function("hasPermission") {
      val context = appContext.reactContext ?: return@Function false
      Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
    }

    Function("configure") { configJson: String ->
      val context = appContext.reactContext ?: return@Function false
      context.getSharedPreferences(OdinOverlayService.PREFERENCES, Context.MODE_PRIVATE)
        .edit().putString(OdinOverlayService.CONFIG_JSON, configJson).apply()
      true
    }

    Function("start") {
      val context = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) return@Function false
      val intent = Intent(context, OdinOverlayService::class.java).setAction(OdinOverlayService.ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      true
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      context.stopService(Intent(context, OdinOverlayService::class.java))
      true
    }

    Function("stopTracking") {
      val context = appContext.reactContext ?: return@Function false
      context.startService(Intent(context, OdinOverlayService::class.java).setAction(OdinOverlayService.ACTION_STOP_TRACKING))
      true
    }

    Function("consumePendingTrigger") {
      val context = appContext.reactContext ?: return@Function false
      val preferences = context.getSharedPreferences(OdinOverlayService.PREFERENCES, Context.MODE_PRIVATE)
      val pending = preferences.getBoolean(OdinOverlayService.PENDING_TRIGGER, false)
      if (pending) preferences.edit().putBoolean(OdinOverlayService.PENDING_TRIGGER, false).apply()
      pending
    }
  }
}
