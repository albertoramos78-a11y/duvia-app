# Thème licorne — Design

## Contexte

Le lot "Thème Licorne 🦄" existe déjà de bout en bout dans l'économie de récompenses (roue de la fortune, boutique à 0,29 €, `sub.earnedLicorne`/`myGifted.licorne`/`sub.earnedSelf_licorne` — mêmes mécanismes que les 4 autres thèmes été/vidéo/RG/WC) mais n'a jamais eu de vraie palette ni de vrai bouton d'activation : le menu « 🏆 lots gagnés » affiche juste un badge statique « Bientôt » (`App.jsx:4453-4458`, `t.wheelSoon`) à la place du bouton bascule que les 4 autres thèmes ont. Demande : en faire un thème réellement activable, au même niveau que les autres.

Décisions validées avec l'utilisateur : palette « Pastel Doux » (choisie parmi 3 propositions via le compagnon visuel), et disponibilité permanente une fois gagné — comme le thème vidéo (`VIDEO` dans `theme.js`, sans fonction `isXPeriod()`), pas comme été/RG/WC qui sont bornés à une période calendaire. Cohérent avec le commentaire déjà présent dans le code, `App.jsx:16023` : `// │ Thème Licorne  (permanent)  │ ...`.

## Décisions de conception

### 1. Palette : nouvelle constante `LICORNE` dans `theme.js`, pas de date-gating

Même structure que les 6 palettes existantes (14 clés + un flag `_licorne:true`) :

```js
export const LICORNE = { bg:"#fdf2fb",card:"#ffffff",sur:"#fce7f8",bor:"#f0abfc",txt:"#581c62",mut:"#a855c7",inp:"#ffffff",vio:"#c026d3",blu:"#818cf8",grn:"#34d399",yel:"#fbbf24",red:"#fb7185",ora:"#fb923c",pin:"#f472b6",_licorne:true };
```

Aucune fonction `isLicornePeriod()` — le thème est disponible dès que gagné/acheté/offert, sans borne de dates, comme `VIDEO`.

### 2. État d'activation : `licorneActive`, même mécanique que `videoActive`

Nouveau `useLocalStorage("duvia_licorne", false)` (`App.jsx:3064`, juste après `videoActive`). Intégré à la chaîne de résolution du thème actif (`App.jsx:3678-3682`) :

```js
const C = useMemo(() =>
  licorneActive ? LICORNE : videoActive ? VIDEO : wcActive ? WC : rgActive ? RG :
  summerActive ? SUMMER : themeMode==="sombre" ? DARK :
  themeMode==="clair" ? LIGHT : BRAND,
[licorneActive, videoActive, wcActive, rgActive, summerActive, themeMode]);
```

### 3. Exclusivité mutuelle avec les 4 autres thèmes, dans les deux sens

Le bouton licorne dans le menu « 🏆 » désactive les 4 autres à l'activation (même schéma que les 4 boutons existants : `setXActive(s=>!s); setYActive(false); setZActive(false); ...`). Réciproquement, il faut ajouter `setLicorneActive(false)` aux 4 boutons existants (été/vidéo/WC/RG, `App.jsx:4438,4446,4461,4469`) pour que choisir un autre thème désactive bien la licorne — sans ça, deux thèmes pourraient rester actifs en même temps (un bug qui n'existe pas aujourd'hui pour les 4 thèmes existants, à ne pas introduire pour le 5e).

### 4. Remplacer le badge statique par un vrai bouton d'activation

`App.jsx:4453-4458` passe de ce `<div>` non cliquable :

```jsx
{(sub.earnedLicorne||myG.licorne||sub.earnedSelf_licorne) && (
  <div style={{...}}>
    <span>🦄</span>
    <span style={{flex:1}}>{t.shopLicorne}...</span>
    <span style={{...}}>{t.wheelSoon}</span>
  </div>
)}
```

à un `<button>` identique en structure à celui du thème vidéo (`App.jsx:4445-4452`), couleur `#ec4899` (déjà utilisée pour licorne ailleurs dans le fichier, ex. `App.jsx:16040,16420`) :

```jsx
{(sub.earnedLicorne||myG.licorne||sub.earnedSelf_licorne) && (
  <button onClick={()=>{setLicorneActive(s=>!s);setSummerActive(false);setRgActive(false);setWcActive(false);setVideoActive(false);setShowPrizesMenu(false);}}
    style={{width:"100%",padding:"0 14px",height:40,background:licorneActive?"#ec489915":"#ec489908",color:"#ec4899",textAlign:"left",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:12,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
    <span style={{fontSize:16}}>🦄</span>
    <span style={{flex:1}}>{t.shopLicorne}{sub.earnedSelf_licorne&&!sub.earnedLicorne?" 🛒":myG.licorne&&!sub.earnedLicorne?" 🎁":""}</span>
    <span style={{background:licorneActive?"#ec489933":"#ec489918",color:"#ec4899",borderRadius:8,padding:"2px 7px",fontSize:10,fontWeight:800}}>{licorneActive?t.wheelActiveCheck:t.wheelApply}</span>
  </button>
)}
```

### 5. Corriger 2 bugs préexistants révélés par l'ajout du vrai état

Trouvés en cherchant tous les usages de `licorne` dans le fichier — les deux traitaient la licorne comme "toujours activable/active" faute d'un état à interroger, une approximation qui devient un vrai bug incohérent une fois `licorneActive` réel :

- `hasActivatable` (`App.jsx:4409`) : `((sub.earnedLicorne||myG.licorne||selfB.licorne)) ||` ne vérifie jamais si c'est déjà actif (contrairement aux 4 autres conditions, qui ont toutes un `&& !xActive`). Devient : `((sub.earnedLicorne||myG.licorne||selfB.licorne) && !licorneActive) ||`.
- `EarnedPrizeRow` dans l'onglet Préférences (`App.jsx:16754-16758`) : affiche en dur `status={t.wheelActive}` (« Actif ✓ ») même quand ce n'est pas le cas. Devient conditionnel comme celui du thème vidéo : `info={licorneActive?t.wheelLicorneActiveInfo:t.wheelActivateViaButton} status={licorneActive?t.wheelActiveCheck:t.wheelApply}`.

## Nouvelles clés i18n

`wheelLicorneActiveInfo` — même contenu que `wheelVideoActiveInfo` (« Thème actif · Désactivez via le menu ☰ ou 🏆 »), décliné pour la licorne, dans `fr/en/de/es/pt`.

## Portée

Inclus : palette, état d'activation, bouton dans le menu 🏆, exclusivité mutuelle bidirectionnelle avec les 4 thèmes existants, correction des 2 incohérences `hasActivatable`/`EarnedPrizeRow`, nouvelle clé i18n.

Hors périmètre : tout changement à l'économie de récompenses (probabilités de la roue, prix boutique, logique de don `giftedPrizes`) — déjà fonctionnels et non touchés. Pas de nouvelle illustration/asset graphique — la palette de couleurs seule habille l'app, comme pour été/RG/WC/vidéo.
