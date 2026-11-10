// One module: the assistant (VoiceInteractionService, its session, a stub recognizer) and its launcher activity.
// Android Gradle Plugin 9 compiles Kotlin itself; the Compose compiler plugin matches the Kotlin it brings in.
plugins {
    id("com.android.application") version "9.5.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21"
}

android {
    namespace = "net.suderman.june"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "net.suderman.june"
        minSdk = 33
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        // QuickJS is native: only the phone's own architecture, not a copy for every Android CPU.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Release builds come out unsigned; the install app signs them with the host's debug key. R8 shrinks Compose and
    // OkHttp to what June uses; the manifest's components and the libraries' own rules keep what reflection needs.
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

dependencies {
    val compose = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(compose)
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    // The WebSocket to June's listener.
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    // QuickJS, to run the decisions the phone shares with the desktop client (assets/june.js, built by Nix).
    implementation("io.github.dokar3:quickjs-kt:1.0.15")
}
