# Babel-Oued

Traducteur français → 🇬🇧 anglais · 🇪🇸 espagnol · 🇩🇪 allemand · 🇮🇹 italien · 🇷🇺 russe,
qui fonctionne hors ligne sur Android, avec explication de chaque mot (grammaire, racine,
mots apparentés dans les autres langues).

- **Hors ligne** : modèles Opus-MT (transformers.js) + dictionnaire tiré du Wiktionnaire (SQLite).
- **En ligne** (clé Gemini gratuite) : traduction idiomatique, traduction en situation, origine d'une phrase,
  explication de chaque mot dans sa phrase avec questions de suivi, vérification automatique.
  Clés Mistral, Groq ou OpenRouter facultatives : prises en secours quand Gemini est saturé.
- **Carnet** (hors ligne) : mots et expressions enregistrés, classés par langue, révisés en flashcards
  (thème ou version) avec répétition espacée. Mode quiz dans l'onglet Traduire.

## Installer sur le téléphone

Chaque push sur `main` compile un APK, publié dans l'onglet **Releases**.

## Voir l'application sur l'ordinateur (mode développement)

Prérequis : [Node.js](https://nodejs.org) 22 ou plus, et Python 3 pour le dictionnaire.

```bash
npm install
npm run dict   # une seule fois : ~6 Go téléchargés temporairement, ~10 min
npm run dev    # puis ouvrir http://localhost:5173
```

Sans `npm run dict`, la traduction marche mais pas le dictionnaire (encadré 💡, clic sur les mots).
