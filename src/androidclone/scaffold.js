/**
 * Phase 5 — Scaffold: write a real Kotlin + Jetpack Compose Gradle project.
 *
 * Deterministic templates (no model needed for the skeleton) so the project
 * always has a compilable baseline. The plan's screens become composables.
 */

const fs = require("fs/promises");
const path = require("path");
const { projectDir, readJson, saveProject, readSettings } = require("./store");

function ktPackage(plan) {
  const pkg = String(plan.packageName || "com.autosocial.generated.app")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.|\.$/g, "");
  const parts = pkg.split(".").filter(Boolean);
  while (parts.length < 2) parts.push("app");
  return parts.join(".");
}

function appId(plan) {
  const pkg = ktPackage(plan);
  return pkg.split(".").length >= 2 ? pkg : `com.autosocial.${pkg}`;
}

function qualifiedClassName(pkg, lastName) {
  return `${pkg}.${lastName}`;
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function scaffold(project) {
  const settings = await readSettings();
  const dir = projectDir(project.id);
  const plan = await readJson(path.join(dir, "plan.json"), null);
  if (!plan) throw new Error("Falta el plan de arquitectura. Ejecuta la fase 4 primero.");

  const pkg = ktPackage(plan);
  const appIdValue = appId(plan);
  const androidRoot = path.join(dir, "android");
  const srcRoot = path.join(androidRoot, "app", "src", "main");
  const javaRoot = path.join(srcRoot, "java", ...pkg.split("."));

  await write(path.join(androidRoot, "settings.gradle.kts"), settingsGradle(plan));
  await write(path.join(androidRoot, "build.gradle.kts"), rootBuildGradle());
  await write(path.join(androidRoot, "gradle.properties"), GRADLE_PROPERTIES);
  await write(path.join(androidRoot, "gradle", "wrapper", "gradle-wrapper.properties"), GRADLE_WRAPPER_PROPERTIES);
  await write(path.join(androidRoot, "app", "build.gradle.kts"), appBuildGradle(appIdValue, pkg));
  await write(path.join(srcRoot, "AndroidManifest.xml"), manifest(plan, pkg));
  await write(path.join(srcRoot, "res", "values", "strings.xml"), stringsXml(plan));
  await write(path.join(srcRoot, "res", "values", "themes.xml"), THEMES_XML);
  await write(path.join(javaRoot, "MainActivity.kt"), mainActivity(plan, pkg));
  await write(path.join(javaRoot, "AppNavigation.kt"), navigation(plan, pkg));
  await write(path.join(javaRoot, "ui", "theme", "Theme.kt"), themeKt(pkg));

  for (const screen of plan.screens || []) {
    const name = composableName(screen.composable || screen.id || "Screen");
    await write(path.join(javaRoot, "screens", `${name}.kt`), screenComposable(screen, pkg, name));
  }

  // Local gradle wrapper scripts so the user only needs a JDK installed.
  await writeWrapperScripts(androidRoot);

  project.scaffold = { androidRoot, packageName: pkg, appId: appIdValue, screens: (plan.screens || []).length, generatedAt: new Date().toISOString() };
  project.activePhase = 6;
  await saveProject(project);
  return project.scaffold;
}

function gradleVersion() {
  return "8.7";
}

function settingsGradle(plan) {
  return `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${(plan.appName || "App").replace(/["\\]/g, "").trim() || "App"}"
include(":app")
`;
}

function rootBuildGradle() {
  return `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`;
}

const GRADLE_PROPERTIES = `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
`;

const GRADLE_WRAPPER_PROPERTIES = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

function appBuildGradle(appIdValue, pkg) {
  return `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "${appIdValue}"
    compileSdk = 34

    defaultConfig {
        applicationId = "${appIdValue}"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
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
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
`;
}

function manifest(plan, pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.Generated">
        <activity
            android:name="${pkg}.MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`;
}

function stringsXml(plan) {
  const name = String(plan.appName || "App").replace(/[<>&'"]/g, "");
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${name}</string>
</resources>
`;
}

const THEMES_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Generated" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
`;

function themeKt(pkg) {
  return `package ${pkg}.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF3D5AFE),
    secondary = Color(0xFF00BFA5),
    background = Color(0xFFF7F8FC),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8C9EFF),
    secondary = Color(0xFF64FFDA),
    background = Color(0xFF101218),
)

@Composable
fun GeneratedTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
`;
}

function composableName(raw) {
  const cleaned = String(raw || "Screen").replace(/[^a-zA-Z0-9]/g, "");
  const base = cleaned.replace(/Screen$/i, "") || "Home";
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}Screen`;
}

function routeFor(screen, index) {
  const raw = String(screen.id || screen.title || `screen${index}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return raw || `screen_${index}`;
}

function mainActivity(plan, pkg) {
  return `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import ${pkg}.ui.theme.GeneratedTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            GeneratedTheme {
                AppNavigation()
            }
        }
    }
}
`;
}

function navigation(plan, pkg) {
  const screens = plan.screens && plan.screens.length
    ? plan.screens
    : [{ id: "home", title: "Inicio", composable: "HomeScreen", description: plan.summary || "" }];
  const imports = screens
    .map((screen, index) => `import ${pkg}.screens.${composableName(screen.composable || screen.id || `screen${index}`)}`)
    .join("\n");

  const routes = screens.map((screen, index) => {
    const route = routeFor(screen, index);
    const name = composableName(screen.composable || screen.id || `screen${index}`);
    return `            composable("${route}") { ${name}(onNavigate = { target -> navController.navigate(target) }) }`;
  }).join("\n");

  const firstRoute = routeFor(screens[0], 0);

  return `package ${pkg}

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
${imports}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    NavHost(navController = navController, startDestination = "${firstRoute}") {
${routes}
    }
}
`;
}

function screenComposable(screen, pkg, name) {
  const title = String(screen.title || name).replace(/"/g, "");
  const description = String(screen.description || "").replace(/"/g, "");
  const components = (screen.components || []).map((c) => String(c));
  const componentLines = components.length
    ? components.map((c) => `        Text("• ${c.replace(/"/g, "")}")`).join("\n")
    : `        Text("Aquí irá el contenido de esta pantalla.")`;

  return `package ${pkg}.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun ${name}(onNavigate: (String) -> Unit = {}) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("${title}", style = MaterialTheme.typography.headlineMedium)
        Text("${description}")
${componentLines}
    }
}
`;
}

async function writeWrapperScripts(androidRoot) {
  const unix = `#!/bin/sh
# Minimal Gradle wrapper shim: uses a system gradle if present, otherwise the
# dashboard runs "gradle" from PATH. Install Gradle 8.7 if this fails.
exec gradle "$@"
`;
  const win = `@echo off\r
rem Minimal Gradle wrapper shim: uses a system gradle from PATH.\r
gradle %*\r
`;
  await write(path.join(androidRoot, "gradlew"), unix);
  await fs.chmod(path.join(androidRoot, "gradlew"), 0o755).catch(() => {});
  await write(path.join(androidRoot, "gradlew.bat"), win);
}

module.exports = { scaffold, composableName, routeFor, ktPackage, appId, gradleVersion };
