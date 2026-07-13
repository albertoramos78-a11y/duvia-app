# Child Info Card → Main Tab Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone header 🧒 button (observer/child roles) with a real tab in the main tab bar, positioned right after Calendrier, showing the same read-only child info content as today.

**Architecture:** `ChildInfoModal` (a fixed-overlay popup) is converted into `ChildInfoTab` (a plain full-page tab component, no props, reads `C`/`t`/`cfg` via `useApp()` like its sibling tab components). The `TABS` array and the `tab===N` render switch for the `isObs`/`isChild` branches both gain one new entry at index 1, shifting every existing tab after it up by one index. The header button, its `showChildInfoModal` state, and its modal render are deleted.

**Tech Stack:** React (single-file `src/App.jsx`), no backend/schema changes.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-child-info-tab-design.md` — read it first.
- All changes are in `src/App.jsx` plus one new key in `src/i18n/fr.js`.
- Bump `src/config.js`'s `APP_VERSION` and `public/sw.js`'s `SW_VERSION` together (per CLAUDE.md) since this changes app code.
- `TZ=Europe/Paris npm test` must stay green (122 tests) — this plan adds no new pure logic, just JSX restructuring.
- No automated test can cover JSX/UI behavior in this repo — the assistant cannot open a browser here, so final confirmation is a manual live-test step for the user.

---

### Task 1: Convert the modal to a tab and rewire the tab bar

**Files:**
- Modify: `src/App.jsx` (function `ChildInfoModal` → `ChildInfoTab`, ~line 2615; `TABS` array, ~line 4406; header button + state, ~lines 3442 and 4734-4739 and 4936; `tab===N` render switch for `isObs`/`isChild`, ~lines 5104-5130)
- Modify: `src/i18n/fr.js` (new key `tabChildInfo`)
- Modify: `src/config.js` (`APP_VERSION`)
- Modify: `public/sw.js` (`SW_VERSION`)

**Interfaces:**
- Consumes: `useApp()` context (already exposes `C`, `t`, `cfg` — same context `ChildInfoModal` already used).
- Produces: `ChildInfoTab()` — a zero-prop component, called as `<ChildInfoTab/>` from the `tab===1` branches, exactly like `<ContactsTab/>`/`<ScheduleTab/>` are called elsewhere. Nothing else in the codebase references `ChildInfoModal`/`showChildInfoModal` after this task (verified by the grep in Step 1).

- [ ] **Step 1: Confirm there are no other references to remove**

Run:
```bash
grep -n "ChildInfoModal\|showChildInfoModal" src/App.jsx
```
Expected output (exactly these 4 lines, matching current `src/App.jsx`):
```
2615:function ChildInfoModal({onClose}) {
3442:  const [showChildInfoModal,setShowChildInfoModal] = useState(false);
4735:            <button onClick={()=>setShowChildInfoModal(true)} title={t.childInfoCardTitle||"Infos enfant"}
4936:      {showChildInfoModal && <ChildInfoModal onClose={()=>setShowChildInfoModal(false)} />}
```
If line numbers differ slightly (earlier edits may have shifted them), locate the same 4 logical spots by content instead of exact line number for the rest of this task.

- [ ] **Step 2: Convert `ChildInfoModal` into `ChildInfoTab`**

Find this function (currently ~line 2615):
```javascript
function ChildInfoModal({onClose}) {
  const {C, t, cfg} = useApp();
  const [selectedChildIdx, setSelectedChildIdx] = useState(0);
  const children = cfg.children || [];
  const ch = children[selectedChildIdx] || children[0] || null;
  const lbl = {fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4};
  const val = {fontSize:14,color:C.txt,lineHeight:1.4};
  const fields = ch ? [
    [t.childAllergy, ch.allergy],
    [t.childBloodType, ch.bloodType],
    [t.childSchool, ch.school ?? ch.home?.school],
    [t.childDoctor, ch.doctor ?? ch.home?.doctor],
    [t.childEmergency, ch.emergencyContacts ?? ch.home?.emergencyContacts],
    [t.childNotes, ch.notes ?? ch.home?.notes],
  ].filter(([, v]) => v && String(v).trim()) : [];
  const birthdate = ch ? formatChildBirthdate(ch.birthDay, ch.birthMonth, ch.birthYear) : "";

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:16,padding:20,maxWidth:420,width:"100%",maxHeight:"80vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexShrink:0}}>
          <div style={{fontSize:16,fontWeight:900,color:C.txt}}>{t.childInfoCardTitle||"🧒 Infos enfant"}</div>
          <button onClick={onClose} style={{width:30,height:30,background:C.sur,border:`1px solid ${C.bor}`,borderRadius:8,color:C.mut,fontSize:14,cursor:"pointer"}}>✕</button>
        </div>
        {children.length === 0 ? (
          <div style={{fontSize:13,color:C.mut,textAlign:"center",padding:"20px 0"}}>{t.childInfoCardEmpty||"Aucun enfant enregistré pour le moment."}</div>
        ) : (
          <div style={{overflowY:"auto",flex:1,display:"flex",flexDirection:"column",gap:14}}>
            {children.length > 1 && (
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {children.map((c,i) => (
                  <button key={i} onClick={()=>setSelectedChildIdx(i)}
                    style={{padding:"6px 12px",borderRadius:20,fontSize:12,fontWeight:700,cursor:"pointer",
                      background:i===selectedChildIdx?C.vio:C.sur,
                      color:i===selectedChildIdx?"#fff":C.txt,
                      border:`1.5px solid ${i===selectedChildIdx?C.vio:C.bor}`}}>
                    {c.name.trim() || `${t.childN} ${i+1}`}
                  </button>
                ))}
              </div>
            )}
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:32,width:48,height:48,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"50%",background:C.sur,flexShrink:0,overflow:"hidden"}}>
                {typeof ch.avatar==="string" && ch.avatar.startsWith("http")
                  ? <img src={ch.avatar} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                  : (ch.avatar || "🧒")}
              </div>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:C.txt}}>{ch.name.trim() || `${t.childN} ${selectedChildIdx+1}`}</div>
                {birthdate && <div style={{fontSize:12,color:C.mut}}>{birthdate}</div>}
              </div>
            </div>
            {fields.map(([label,value],i) => (
              <div key={i}>
                <div style={lbl}>{label}</div>
                <div style={val}>{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Replace it with (drops the overlay wrapper and the close button, keeps everything else byte-identical):
```javascript
function ChildInfoTab() {
  const {C, t, cfg} = useApp();
  const [selectedChildIdx, setSelectedChildIdx] = useState(0);
  const children = cfg.children || [];
  const ch = children[selectedChildIdx] || children[0] || null;
  const lbl = {fontSize:10,fontWeight:700,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4};
  const val = {fontSize:14,color:C.txt,lineHeight:1.4};
  const fields = ch ? [
    [t.childAllergy, ch.allergy],
    [t.childBloodType, ch.bloodType],
    [t.childSchool, ch.school ?? ch.home?.school],
    [t.childDoctor, ch.doctor ?? ch.home?.doctor],
    [t.childEmergency, ch.emergencyContacts ?? ch.home?.emergencyContacts],
    [t.childNotes, ch.notes ?? ch.home?.notes],
  ].filter(([, v]) => v && String(v).trim()) : [];
  const birthdate = ch ? formatChildBirthdate(ch.birthDay, ch.birthMonth, ch.birthYear) : "";

  return (
    <div>
      <div style={{fontSize:16,fontWeight:900,color:C.txt,marginBottom:14}}>{t.childInfoCardTitle||"🧒 Infos enfant"}</div>
      {children.length === 0 ? (
        <div style={{fontSize:13,color:C.mut,textAlign:"center",padding:"20px 0"}}>{t.childInfoCardEmpty||"Aucun enfant enregistré pour le moment."}</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {children.length > 1 && (
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {children.map((c,i) => (
                <button key={i} onClick={()=>setSelectedChildIdx(i)}
                  style={{padding:"6px 12px",borderRadius:20,fontSize:12,fontWeight:700,cursor:"pointer",
                    background:i===selectedChildIdx?C.vio:C.sur,
                    color:i===selectedChildIdx?"#fff":C.txt,
                    border:`1.5px solid ${i===selectedChildIdx?C.vio:C.bor}`}}>
                  {c.name.trim() || `${t.childN} ${i+1}`}
                </button>
              ))}
            </div>
          )}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{fontSize:32,width:48,height:48,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"50%",background:C.sur,flexShrink:0,overflow:"hidden"}}>
              {typeof ch.avatar==="string" && ch.avatar.startsWith("http")
                ? <img src={ch.avatar} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                : (ch.avatar || "🧒")}
            </div>
            <div>
              <div style={{fontSize:16,fontWeight:800,color:C.txt}}>{ch.name.trim() || `${t.childN} ${selectedChildIdx+1}`}</div>
              {birthdate && <div style={{fontSize:12,color:C.mut}}>{birthdate}</div>}
            </div>
          </div>
          {fields.map(([label,value],i) => (
            <div key={i}>
              <div style={lbl}>{label}</div>
              <div style={val}>{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Insert the new tab into `TABS` for both observer and child roles**

Find (~line 4406):
```javascript
  const TABS = (isObs && !isAdm)
    ? [{icon:"📅",label:t.tabCal},{icon:"📞",label:t.tabContacts||"Contacts"},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}]
    : (isChild && !isAdm)
    ? [
        {icon:"📅",label:t.tabCal},
        {icon:"🎒",label:t.tabSchedule||"EDT"},
        {icon:"📞",label:t.tabContacts||"Contacts"},
        {icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},
      ]
    : [{icon:"📅",label:t.tabCal},{icon:"🎒",label:t.tabSchedule||"EDT"},{icon:"💰",label:t.tabExp,badge:expPendingCount},{icon:"📞",label:t.tabContacts||"Contacts",badge:contactsDot?1:0},{icon:"🗄️",label:t.tabVault||"Coffre",badge:vaultBadgeCount},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}];
```

Replace with (only the `isObs` and `isChild` branches change — the full-parent branch on the last line is untouched):
```javascript
  const TABS = (isObs && !isAdm)
    ? [{icon:"📅",label:t.tabCal},{icon:"🧒",label:t.tabChildInfo||"Enfant"},{icon:"📞",label:t.tabContacts||"Contacts"},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}]
    : (isChild && !isAdm)
    ? [
        {icon:"📅",label:t.tabCal},
        {icon:"🧒",label:t.tabChildInfo||"Enfant"},
        {icon:"🎒",label:t.tabSchedule||"EDT"},
        {icon:"📞",label:t.tabContacts||"Contacts"},
        {icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},
      ]
    : [{icon:"📅",label:t.tabCal},{icon:"🎒",label:t.tabSchedule||"EDT"},{icon:"💰",label:t.tabExp,badge:expPendingCount},{icon:"📞",label:t.tabContacts||"Contacts",badge:contactsDot?1:0},{icon:"🗄️",label:t.tabVault||"Coffre",badge:vaultBadgeCount},{icon:"💬",label:t.tabMsg||"Messages",badge:unreadMsgs},{icon:"🎡",label:t.tabGame||"Jeu"}];
```

- [ ] **Step 4: Shift the observer tab-content render and insert `ChildInfoTab`**

Find (~line 5104):
```javascript
                {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
                {tab===1 && <ContactsTab readOnly />}
                {tab===2 && <MessagingTab />}
                {tab===3 && <GameTab />}
```
This exact 4-line block appears twice in the file — once for the observer branch (~line 5104) and once at the very start of the child branch before it's further edited in Step 5 (~line 5124). Edit **only the first occurrence** (the one inside the `(isObs && !isAdm) ? (...)` block — check a few lines above the match for `menuTab==="prefs"` and `ObserverPrefsTab` immediately preceding it to confirm you're in the observer branch, not the child branch).

Replace with:
```javascript
                {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
                {tab===1 && <ChildInfoTab />}
                {tab===2 && <ContactsTab readOnly />}
                {tab===3 && <MessagingTab />}
                {tab===4 && <GameTab />}
```

- [ ] **Step 5: Shift the child tab-content render and insert `ChildInfoTab`**

Find (~line 5124, the second/remaining occurrence of the pattern from Step 4 — confirm it's the child branch by checking a few lines above for `(isChild && !isAdm)`):
```javascript
                {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
                {tab===1 && <ScheduleTab childReadOnly />}
                {tab===2 && <ContactsTab addOnly />}
                {tab===3 && <MessagingTab />}
                {tab===4 && <GameTab />}
```

Replace with:
```javascript
                {tab===0 && <CalTab readOnly updateCal={()=>{}} />}
                {tab===1 && <ChildInfoTab />}
                {tab===2 && <ScheduleTab childReadOnly />}
                {tab===3 && <ContactsTab addOnly />}
                {tab===4 && <MessagingTab />}
```
(The `tab===4 && <GameTab />` line from the original is intentionally dropped — it was already unreachable dead code, since the child `TABS` array only ever had 4 entries before this plan, and now has 5 with no `GameTab` among them.)

- [ ] **Step 6: Remove the header button, its state, and the old modal render**

Delete this state declaration (~line 3442):
```javascript
  const [showChildInfoModal,setShowChildInfoModal] = useState(false);
```

Delete this button block (~lines 4734-4739):
```javascript
          {(isObs||isChild) && !isAdm && (
            <button onClick={()=>setShowChildInfoModal(true)} title={t.childInfoCardTitle||"Infos enfant"}
              style={{height:36,padding:"0 14px",background:C.card,border:`1.5px solid ${C.bor}`,color:C.txt,fontSize:16,fontWeight:700,borderRadius:20,display:"flex",alignItems:"center",cursor:"pointer",flexShrink:0}}>
              🧒
            </button>
          )}
```

Delete this modal render line (~line 4936):
```javascript
      {showChildInfoModal && <ChildInfoModal onClose={()=>setShowChildInfoModal(false)} />}
```

- [ ] **Step 7: Add the new i18n key**

In `src/i18n/fr.js`, find the `// --- i18n additions ---` section near the end of the file and add one line before the closing `};`:
```javascript
    tabChildInfo:"Enfant",
```

- [ ] **Step 8: Verify no leftover references and run the build + test suite**

```bash
grep -n "ChildInfoModal\|showChildInfoModal" src/App.jsx
```
Expected: no output (both fully removed).

```bash
npm run build
```
Expected: builds successfully, no errors.

```bash
TZ=Europe/Paris npm test
```
Expected: `pass 122`, `fail 0` (unchanged from before this task — no new pure-logic function was added).

- [ ] **Step 9: Bump the version**

In `src/config.js`, increment `APP_VERSION` by 0.01 from its current value.
In `public/sw.js`, set `SW_VERSION` to the same new value.

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx src/i18n/fr.js src/config.js public/sw.js
git commit -m "Move the read-only child info card into the main tab bar

Replaces the standalone header 🧒 button (observer/child roles) with
a real tab (ChildInfoTab, converted from ChildInfoModal), inserted
right after Calendrier — one entry point instead of two.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 11 (manual, user only): Live-test**

1. Log in as an observer test account → confirm the tab bar now reads Calendrier, 🧒 Enfant, Contacts, Messages, Jeu (5 tabs) and the header no longer shows a separate 🧒 button.
2. Tap the new "Enfant" tab → confirm it shows the same child info as before (avatar, birthdate, allergy/school/doctor/etc. fields, multi-child selector if the family has more than one child).
3. Repeat steps 1-2 logged in as a child test account (tab bar: Calendrier, 🧒 Enfant, EDT, Contacts, Messages).
4. Confirm switching between tabs still works normally (no blank tab, no crash) for both roles.
