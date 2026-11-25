package app.scrobbler

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Тонкая оболочка: показывает локальную страницу из assets/www и даёт ей то,
 * чего нет в браузере: HTTP без ограничений CORS, MD5 для подписи Last.fm, SHA-256 для входа в Spotify (PKCE),
 * открытие ссылок во внешнем браузере и приём ответа Spotify по адресу scrobbler://callback.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    /** Адрес scrobbler://callback?code=…, с которым браузер вернул пользователя в приложение. */
    @Volatile
    private var pendingCallback: String = ""

    private fun captureCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "scrobbler" && data.host == "callback") {
            pendingCallback = data.toString()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureCallback(intent)

        window.statusBarColor = Color.parseColor("#070816")
        window.navigationBarColor = Color.parseColor("#05060F")

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#070816"))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
        }
        web.webViewClient = object : WebViewClient() {
            // Свои страницы открываем внутри, любые внешние ссылки — в браузере телефона.
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return true
                if (url.scheme == "file") return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }
        }
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "Native")
        setContentView(web)
        web.loadUrl("file:///android_asset/www/index.html")
    }

    /** Приложение уже открыто, а браузер вернул пользователя по адресу scrobbler://callback. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureCallback(intent)
        web.evaluateJavascript("window.__spotifyCallback && window.__spotifyCallback()", null)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Методы вызываются со страницы как window.Native.<имя>(...). */
    inner class Bridge {

        @JavascriptInterface
        fun md5(input: String): String {
            val digest = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }

        /** SHA-256 в base64url без «=»: так Spotify ждёт code_challenge в PKCE. */
        @JavascriptInterface
        fun sha256(input: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
            return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        }

        /** Отдаёт адрес возврата из Spotify (один раз) или пустую строку. */
        @JavascriptInterface
        fun takeCallback(): String {
            val value = pendingCallback
            pendingCallback = ""
            return value
        }

        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("scrobbler", text))
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            val uri = Uri.parse(url)
            if (uri.scheme != "https" && uri.scheme != "http") return
            runOnUiThread {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (_: ActivityNotFoundException) {
                }
            }
        }

        @JavascriptInterface
        fun keepAwake(on: Boolean) {
            runOnUiThread {
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        /** Асинхронный HTTP: результат возвращается в window.__nativeHttpDone(id, base64(JSON)). */
        @JavascriptInterface
        fun http(id: Int, method: String, url: String, headersJson: String, body: String) {
            thread {
                val result = JSONObject()
                try {
                    val target = URL(url)
                    require(target.protocol == "https") { "разрешён только https" }
                    val conn = target.openConnection() as HttpURLConnection
                    conn.requestMethod = method
                    conn.connectTimeout = 20_000
                    conn.readTimeout = 30_000
                    conn.setRequestProperty("User-Agent", "LastfmScrobbler/1.1 (Android)")
                    val headers = JSONObject(headersJson)
                    for (key in headers.keys()) {
                        conn.setRequestProperty(key, headers.getString(key))
                    }
                    if (method == "POST") {
                        conn.doOutput = true
                        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    }
                    val code = conn.responseCode
                    val stream = if (code >= 400) conn.errorStream else conn.inputStream
                    val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                    result.put("status", code)
                    result.put("body", text)
                    conn.disconnect()
                } catch (e: Exception) {
                    result.put("status", 0)
                    result.put("error", e.message ?: e.javaClass.simpleName)
                }
                val b64 = Base64.encodeToString(result.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                runOnUiThread {
                    web.evaluateJavascript("window.__nativeHttpDone($id,\"$b64\")", null)
                }
            }
        }
    }
}
