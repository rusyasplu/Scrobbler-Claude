plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.scrobbler"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.scrobbler"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "1.1.1"
    }

    // Один и тот же ключ подписи при каждой сборке: тогда новые APK ставятся поверх старых
    // без удаления приложения. Это обычный отладочный ключ, для личного использования достаточно.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Внешних зависимостей нет: интерфейс — это веб-страница в WebView из app/src/main/assets/www.
