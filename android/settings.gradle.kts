// June's Android assistant. Built by Nix with nixpkgs' Gradle and the Maven dependencies locked in deps.json; see
// default.nix, and "Proof of concept" in docs/interfaces.org.
pluginManagement {
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
rootProject.name = "june"
