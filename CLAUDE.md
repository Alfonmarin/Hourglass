# OurGlass — contexte projet

À lire avant toute action.

## Quel projet

Le vrai projet ici est **OurGlass** : `/home/max/Project/gator-safe-app`.

⚠️ Ne pas confondre avec `/home/max/Project/safe-subscriptions`. C'est un **autre
repo** dont les règles `.claude/rules/*.md` se chargent automatiquement dans
l'environnement — elles **ne s'appliquent pas** à OurGlass. Tout le travail
OurGlass se fait dans ce dossier (`gator-safe-app`).

Identité du repo :
- Fork de `osobot-ai/gator-safe-app`
- `origin` = `github.com/Wieedze/SubscRight`
- Rebrandé de **SubscRight → OurGlass**

## Stack & commandes

Safe App. Vite + React + TypeScript, Tailwind CSS v4 (tokens dans le bloc
`@theme` de `src/index.css`, pas de `tailwind.config`), wagmi/viem,
`@safe-global/safe-apps-react-sdk`.

- Dev : `bun run dev` → http://localhost:5173
- Build : `bun run build` (`tsc -b && vite build`)
- Toolchain hors PATH par défaut : bun = `/home/max/.bun/bin`,
  node = `/home/max/.nvm/versions/node/v22.21.1/bin` (préfixer le PATH).

## Branding déjà fait (continuer, ne pas refaire)

- Nom `SubscRight → OurGlass` partout : `index.html` (title),
  `public/manifest.json`, wordmark dans `src/ui/components.tsx` (Logo : "Our" +
  "Glass" en accent), `src/pages/Landing.tsx`, `src/pages/Home.tsx`, commentaires
  d'en-tête.
- Logo = **sablier avec des tokens qui coulent** (remplace le bouclier+éclair) :
  composant `Logo` dans `src/ui/components.tsx` + favicon `public/logo.svg`.
  Animation `og-token-drop` (token qui tombe), coupée si `prefers-reduced-motion`.
- Design **"blue glass" / glassmorphism** : utilitaires `.glass` / `.glass-soft` /
  `.glass-strong` dans `src/index.css` (translucide + `backdrop-filter: blur`).
  Appliqués au primitive `Card`, à la sidebar (`App.tsx`), nav active, inputs, à
  la bannière de statut (`Home.tsx`) et au `StandaloneRedeem` (header sticky +
  panneaux). Halos bleus renforcés dans le `body` pour que le flou capte la
  couleur.
- **Palette inchangée** : on garde le bleu existant (`--color-primary #3b82f6`,
  accent cyan `#22d3ee`). Ne pas changer les couleurs sauf demande explicite.

## Déploiement

- On a quitté Vercel → maintenant hébergé sur **Coolify**. Tout est déployé.
- URL live (et URL à enregistrer comme Safe App) : **https://hourglass.box/**
- Une variable d'env manquante/non configurée était la cause de l'erreur Safe
  « doesn't support Safe App functionality ». Elle est maintenant en place côté
  Coolify.

## Reste à faire (optionnel)

Uniformiser le verre sur les pages Create / Delegations / Import / Charge /
Withdraw : leurs cartes héritent déjà du verre via `Card`, mais des encarts
internes `bg-raised` restent opaques.
