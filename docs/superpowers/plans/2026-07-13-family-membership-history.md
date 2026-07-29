# Journaliser les arrivées/départs de la famille dans l'Historique — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `"family"` History entry type, written from the acting device only at every join/leave/removal action point, so the Historique tab shows family membership changes alongside expenses/documents/etc.

**Architecture:** Reuses the existing `addHist(action, detail, type)` helper (`App.jsx:4174`) — no new backend, no new hook. Nine call sites across four components (`App()` itself, `StepId`, `StepAccess`, `ConfigTab`) each get one `addHist(...)` call added right after their existing `familySync.validateMember(...)` / `familySync.leaveFamily(...)` / `familySync.removeFamilyMember(...)` call succeeds. Two of those four components don't currently pull `addHist` from `useApp()` and need that added to their existing destructure line.

**Tech Stack:** React (`src/App.jsx` only).

## Global Constraints

- New History `type` value: exactly `"family"`.
- Entry text templates (exact, `who` is the affected member's name, computed per-site as shown in each step below):
  - Join: `` `${who} a rejoint la famille` ``
  - Voluntary leave: `` `${who} a quitté la famille` ``
  - Removed by someone else: `` `${who} a été retiré de la famille` ``
  - All three calls: `addHist(<text above>, "", "family")` — empty `detail`, since the name is already in the action text.
- The `addHist` call must be added at the **call site of the action** (validateMember/leaveFamily/removeFamilyMember), never inside `useFamilySync`'s realtime detection code (the `duvia-invite-left` event) — every currently-connected family member's client would otherwise independently insert a duplicate row into the shared `history` table. Do not touch `useFamilySync`, `duvia-invite-left`, or `useHistory.ts` in this plan.
- Known, accepted gap (do not attempt to fix): a departure caused by account deletion (server-side, no client action) is not logged. Do not modify the `delete-account` Edge Function for this plan.
- Add `"family"` to `HistTab`'s `TYPE_ICON` and `TYPE_LABEL` maps (`App.jsx:12101-12102`) — but NOT to `TYPE_MAP` (`App.jsx:12100`), since there is no tab to navigate to for a family-membership entry; this matches the existing `"backup"` type's behavior (non-clickable).
- Bump `APP_VERSION` (`src/config.js`) and `SW_VERSION` (`public/sw.js`) together, final step.
- Test command: `TZ=Europe/Paris npm test` (must stay at 122 passing — no new pure function expected). Build: `npm run build`.

---

### Task 1: Add `"family"` History entries at all 9 join/leave/removal call sites

**Files:**
- Modify: `src/App.jsx` (9 call sites across 4 components, plus 2 `useApp()` destructure lines, plus `HistTab`'s `TYPE_ICON`/`TYPE_LABEL`)

**Interfaces:**
- Consumes: `addHist(action, detail, type)`, already defined in `App()` (`App.jsx:4174-4176`) and already exposed via `useApp()`'s context value (confirm it's in the object returned around `App.jsx:4478` — it already is, per the existing `addHist,` entry there).
- Produces: nothing new — this is the only task in this plan.

- [ ] **Step 1: `StepAccess` — add `addHist` to its `useApp()` destructure**

Find this exact line in `StepAccess` (`App.jsx:10336`):
```js
  const {C,t,cfg,setCfg,pushNotif,prem,perms,onUpgrade,user,familySync,isObs,isChild} = useApp();
```
Replace with:
```js
  const {C,t,cfg,setCfg,pushNotif,prem,perms,onUpgrade,user,familySync,isObs,isChild,addHist} = useApp();
```

- [ ] **Step 2: `StepAccess` — log a join when a pending parent is validated (site 1 of 3 in this component)**

Find this exact block (`App.jsx:10464-10475`):
```js
            <button disabled={pendingActionId===m.userId} onClick={async ()=>{
              setPendingActionId(m.userId);
              // 🔧 Cherche la carte observateur correspondante par token (fiable) ou email
              const obsCard = m.role==="observer" ? (cfg.observers||[]).find(o=>
                (m.inviteToken && o.inviteToken && m.inviteToken===o.inviteToken) ||
                (m.email && o.email && o.email===m.email) ||
                (m.displayName && (o.email===m.displayName || o.name===m.displayName))
              ) : null;
              const res = await familySync.validateMember(obsCard ? {...m, obsCardId: obsCard.id} : m);
              setPendingActionId(null);
              if(!res.ok) alert("⚠️ Erreur lors de la validation.");
            }} style={{padding:"7px 12px",background:C.grn,color:"#fff",borderRadius:8,fontSize:12,fontWeight:800,opacity:pendingActionId===m.userId?0.6:1}}>Valider</button>
```
Replace with:
```js
            <button disabled={pendingActionId===m.userId} onClick={async ()=>{
              setPendingActionId(m.userId);
              // 🔧 Cherche la carte observateur correspondante par token (fiable) ou email
              const obsCard = m.role==="observer" ? (cfg.observers||[]).find(o=>
                (m.inviteToken && o.inviteToken && m.inviteToken===o.inviteToken) ||
                (m.email && o.email && o.email===m.email) ||
                (m.displayName && (o.email===m.displayName || o.name===m.displayName))
              ) : null;
              const res = await familySync.validateMember(obsCard ? {...m, obsCardId: obsCard.id} : m);
              setPendingActionId(null);
              if(!res.ok) alert("⚠️ Erreur lors de la validation.");
              else { const who = m.displayName || m.email || (m.role==="observer" ? (t.roleObs||"Observateur") : "Parent invité"); addHist(`${who} a rejoint la famille`, "", "family"); }
            }} style={{padding:"7px 12px",background:C.grn,color:"#fff",borderRadius:8,fontSize:12,fontWeight:800,opacity:pendingActionId===m.userId?0.6:1}}>Valider</button>
```

- [ ] **Step 3: `StepAccess` — log a join when an observer card's own pending match is validated (site 2 of 3)**

Find this exact block (`App.jsx:10653-10658`):
```js
              <button disabled={pendingActionId===matchingPending.userId} onClick={async()=>{
                setPendingActionId(matchingPending.userId);
                const res = await familySync.validateMember({...matchingPending, obsCardId: o.id});
                setPendingActionId(null);
                if(!res.ok) alert("⚠️ Erreur lors de la validation.");
              }} style={{flex:1,height:42,background:C.grn,color:"#fff",fontSize:13,fontWeight:800,borderRadius:10,opacity:pendingActionId===matchingPending.userId?0.6:1}}>{t.obsApprove||"Accepter"}</button>
```
Replace with:
```js
              <button disabled={pendingActionId===matchingPending.userId} onClick={async()=>{
                setPendingActionId(matchingPending.userId);
                const res = await familySync.validateMember({...matchingPending, obsCardId: o.id});
                setPendingActionId(null);
                if(!res.ok) alert("⚠️ Erreur lors de la validation.");
                else { const who = matchingPending.displayName || o.name || matchingPending.email || "Cet observateur"; addHist(`${who} a rejoint la famille`, "", "family"); }
              }} style={{flex:1,height:42,background:C.grn,color:"#fff",fontSize:13,fontWeight:800,borderRadius:10,opacity:pendingActionId===matchingPending.userId?0.6:1}}>{t.obsApprove||"Accepter"}</button>
```

- [ ] **Step 4: `StepAccess` — log a removal when an observer card is removed (site 3 of 3)**

Find this exact block (`App.jsx:10579-10586`):
```js
              <button onClick={async e=>{
                e.stopPropagation();
                if(!window.confirm((t.removeFromFamilyConfirm||"Retirer {name} de la famille ?").replace("{name}",o.name||o.email||"cet observateur"))) return;
                // Supprimer de Supabase si l'observateur a un compte (userId)
                if(o.userId){ await familySync.removeFamilyMember(o.userId); }
                // Supprimer de cfg local
                setCfg(c=>({...c,observers:c.observers.filter(x=>x.id!==o.id)}));
              }} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12,borderRadius:6}}>{t.remove}</button>
```
Replace with:
```js
              <button onClick={async e=>{
                e.stopPropagation();
                if(!window.confirm((t.removeFromFamilyConfirm||"Retirer {name} de la famille ?").replace("{name}",o.name||o.email||"cet observateur"))) return;
                // Supprimer de Supabase si l'observateur a un compte (userId)
                if(o.userId){ await familySync.removeFamilyMember(o.userId); }
                addHist(`${o.name||o.email||"Cet observateur"} a été retiré de la famille`, "", "family");
                // Supprimer de cfg local
                setCfg(c=>({...c,observers:c.observers.filter(x=>x.id!==o.id)}));
              }} style={{padding:"5px 9px",background:"transparent",color:C.red,border:`1px solid ${C.red}`,fontSize:12,borderRadius:6}}>{t.remove}</button>
```
(This one logs unconditionally, matching the existing code's own lack of an `if(res.ok)` check on `removeFamilyMember` at this specific site — not introduced by this task, an existing pattern being followed as-is.)

- [ ] **Step 5: `StepId` — add `addHist` to its `useApp()` destructure**

Find this exact line in `StepId` (`App.jsx:8401`):
```js
  const {C,t,cfg,setCfg,prem,perms,onUpgrade,user,sub,familySync,isChild,isObs} = useApp();
```
Replace with:
```js
  const {C,t,cfg,setCfg,prem,perms,onUpgrade,user,sub,familySync,isChild,isObs,addHist} = useApp();
```

- [ ] **Step 6: `StepId` — log a join when a pending parent is validated**

Find this exact block (`App.jsx:8571-8578`):
```js
                    <button disabled={pidActing===m.userId} onClick={async()=>{
                      setPidActing(m.userId);
                      const res=await familySync.validateMember(m);
                      setPidActing(null);
                      if(!res.ok) alert("⚠️ Erreur lors de la validation.");
                    }} style={{flex:1,height:40,background:C.grn,color:"#fff",borderRadius:9,fontSize:13,fontWeight:800,opacity:pidActing===m.userId?0.6:1}}>
                      {pidActing===m.userId?"⏳…":"✅ Valider"}
                    </button>
```
Replace with:
```js
                    <button disabled={pidActing===m.userId} onClick={async()=>{
                      setPidActing(m.userId);
                      const res=await familySync.validateMember(m);
                      setPidActing(null);
                      if(!res.ok) alert("⚠️ Erreur lors de la validation.");
                      else { const who = m.displayName || m.email || "Cette personne"; addHist(`${who} a rejoint la famille`, "", "family"); }
                    }} style={{flex:1,height:40,background:C.grn,color:"#fff",borderRadius:9,fontSize:13,fontWeight:800,opacity:pidActing===m.userId?0.6:1}}>
                      {pidActing===m.userId?"⏳…":"✅ Valider"}
                    </button>
```

- [ ] **Step 7: `ConfigTab` — log a voluntary leave in `quitterFamille()`**

`ConfigTab` already destructures `addHist` from `useApp()` (`App.jsx:7931`) — no change needed there.

Find this exact block (`App.jsx:8094-8097`):
```js
    const res = await familySync?.leaveFamily?.();
    if(res?.ok){ duviaReload(); }
    else { alert("⚠️ Impossible de quitter la famille.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « leave_family », la migration SQL 0018 n'est pas encore exécutée sur Supabase.)"); }
  }
```
Replace with:
```js
    const res = await familySync?.leaveFamily?.();
    if(res?.ok){
      const who = cfg.parents?.[user?.parentIdx]?.name || user?.name || "Ce parent";
      addHist(`${who} a quitté la famille`, "", "family");
      duviaReload();
    }
    else { alert("⚠️ Impossible de quitter la famille.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « leave_family », la migration SQL 0018 n'est pas encore exécutée sur Supabase.)"); }
  }
```

- [ ] **Step 8: `ConfigTab` — log a removal in `retirerInvite(i)`**

Find this exact block (`App.jsx:8113-8119`):
```js
    if(!window.confirm((t.retirerInviteConfirm||"Retirer {name} de la famille ?\n\nIl repartira sur une famille personnelle vierge. Vous conservez la famille et son code.").replace("{name}",p.name||t.guestLabel||"l'invité"))) return;
    const res = await familySync?.removeFamilyMember?.(p.userId);
    if(res?.ok){
      setCfg(c=>({...c, parents:c.parents.filter((_,j)=>j!==i)}));
    } else {
      alert("⚠️ Impossible de retirer l'invité.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « remove_family_member », la migration SQL 0017 n'est pas encore exécutée sur Supabase.)");
    }
  }
```
Replace with:
```js
    if(!window.confirm((t.retirerInviteConfirm||"Retirer {name} de la famille ?\n\nIl repartira sur une famille personnelle vierge. Vous conservez la famille et son code.").replace("{name}",p.name||t.guestLabel||"l'invité"))) return;
    const res = await familySync?.removeFamilyMember?.(p.userId);
    if(res?.ok){
      addHist(`${p.name||t.guestLabel||"L'invité"} a été retiré de la famille`, "", "family");
      setCfg(c=>({...c, parents:c.parents.filter((_,j)=>j!==i)}));
    } else {
      alert("⚠️ Impossible de retirer l'invité.\n\nDétail : "+(res?.error||"inconnu")+"\n\n(Si l'erreur mentionne « remove_family_member », la migration SQL 0017 n'est pas encore exécutée sur Supabase.)");
    }
  }
```

- [ ] **Step 9: `ConfigTab` — log a removal in `executeDeletion(i)`**

Find this exact block (`App.jsx:8146-8152`):
```js
    if(parent.userId){
      familySync?.removeFamilyMember?.(parent.userId).then(res=>{
        if(res && !res.ok) console.warn("[Duvia] removeFamilyMember:", res.error);
      });
    } else {
      console.warn("[Duvia] executeDeletion: pas de userId sur le parent — retrait serveur impossible.");
    }
```
Replace with:
```js
    if(parent.userId){
      familySync?.removeFamilyMember?.(parent.userId).then(res=>{
        if(res && !res.ok) console.warn("[Duvia] removeFamilyMember:", res.error);
        else addHist(`${parentName} a été retiré de la famille`, "", "family");
      });
    } else {
      console.warn("[Duvia] executeDeletion: pas de userId sur le parent — retrait serveur impossible.");
    }
```
(`parentName` is already computed two lines above this block, at `App.jsx:8139` — `const parentName = parent.name || \`Parent ${i+1}\`;`. Do not redefine it.)

- [ ] **Step 10: `App()` — log a voluntary leave in the observer header-menu button**

`App()` already has `addHist` defined directly in its own body (`App.jsx:4174-4176`) — no destructure needed, it's called as a plain function.

Find this exact block (`App.jsx:4814-4822`):
```js
                  <button onClick={async()=>{
                    if(!window.confirm(t.obsLeaveFamilyConfirm||"Quitter la famille ? Vous n'aurez plus accès au calendrier ni à la messagerie.")) return;
                    await familySync?.leaveFamily?.();
                    setShowMenu(false);
                    handleSetUser(null); setTab(0);
                  }} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.red,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🚪</span>
                    <span style={{flex:1,textAlign:"left"}}>{t.obsLeaveFamily||"Quitter la famille"}</span>
                  </button>
```
Replace with:
```js
                  <button onClick={async()=>{
                    if(!window.confirm(t.obsLeaveFamilyConfirm||"Quitter la famille ? Vous n'aurez plus accès au calendrier ni à la messagerie.")) return;
                    await familySync?.leaveFamily?.();
                    addHist(`${user?.name||"Cet observateur"} a quitté la famille`, "", "family");
                    setShowMenu(false);
                    handleSetUser(null); setTab(0);
                  }} style={{width:"100%",padding:"0 16px",height:44,background:"transparent",color:C.red,display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.bor}`,fontSize:13,fontWeight:600,borderRadius:0,cursor:"pointer"}}>
                    <span style={{fontSize:17,width:22,textAlign:"center",flexShrink:0}}>🚪</span>
                    <span style={{flex:1,textAlign:"left"}}>{t.obsLeaveFamily||"Quitter la famille"}</span>
                  </button>
```

- [ ] **Step 11: `App()` — log a voluntary leave in the "famille dissoute" screen**

Find this exact block (`App.jsx:5078-5081`):
```js
                <button onClick={async()=>{if(!window.confirm(t.leaveFamilyConfirmSimple||"Quitter la famille ?")) return; await familySync?.leaveFamily?.(); handleSetUser(null); setTab(0);}}
                  style={{height:44,padding:"0 24px",background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:14,cursor:"pointer"}}>
                  🚪 {t.obsLeaveFamily||"Quitter la famille"}
                </button>
```
Replace with:
```js
                <button onClick={async()=>{if(!window.confirm(t.leaveFamilyConfirmSimple||"Quitter la famille ?")) return; await familySync?.leaveFamily?.(); addHist(`${user?.name||"Cet observateur"} a quitté la famille`, "", "family"); handleSetUser(null); setTab(0);}}
                  style={{height:44,padding:"0 24px",background:C.red,color:"#fff",border:"none",borderRadius:12,fontWeight:800,fontSize:14,cursor:"pointer"}}>
                  🚪 {t.obsLeaveFamily||"Quitter la famille"}
                </button>
```

- [ ] **Step 12: `HistTab` — add the `"family"` type to the display maps**

Find this exact block (`App.jsx:12100-12102`):
```js
  const TYPE_MAP   = {"cal":0,"schedule":1,"exp":2,"contacts":3,"vault":4,"msg":5};
  const TYPE_ICON  = {"cal":"📅","schedule":"🏫","exp":"💰","contacts":"📞","vault":"🗄️","msg":"💬"};
  const TYPE_LABEL = {"cal":"Calendrier","schedule":"EDT","exp":"Dépenses","contacts":"Contacts","vault":"Coffre","msg":"Messages"};
```
Replace with:
```js
  const TYPE_MAP   = {"cal":0,"schedule":1,"exp":2,"contacts":3,"vault":4,"msg":5};
  const TYPE_ICON  = {"cal":"📅","schedule":"🏫","exp":"💰","contacts":"📞","vault":"🗄️","msg":"💬","family":"👪"};
  const TYPE_LABEL = {"cal":"Calendrier","schedule":"EDT","exp":"Dépenses","contacts":"Contacts","vault":"Coffre","msg":"Messages","family":"Famille"};
```
(`TYPE_MAP` deliberately unchanged — `"family"` entries stay non-clickable, matching the existing `"backup"` type.)

- [ ] **Step 13: Run the test suite**

Run: `TZ=Europe/Paris npm test`
Expected: `# pass 122` (unchanged — no test covers these event handlers or `HistTab`).

- [ ] **Step 14: Build**

Run: `npm run build`
Expected: build succeeds with no errors (the pre-existing "chunks are larger than 500 kB" warning is expected and unrelated).

- [ ] **Step 15: Manual verification checklist (for the report, not automatable)**

Note in your report that the following still needs a live check by the user after deploy (no browser tooling in this environment, and the shared/realtime nature of the `history` table specifically needs a two-account test to catch duplicates):
1. With two test accounts/browsers in the same family, have one validate a pending join request — confirm exactly ONE "a rejoint la famille" entry appears in the Historique for BOTH accounts (not two).
2. Have one account leave voluntarily, or have a parent remove another member — confirm exactly ONE "a quitté"/"a été retiré" entry appears, visible to remaining members.
3. Confirm the History filter chips show a "👪 Famille" option once at least one such entry exists, and that clicking a family-type entry does nothing (non-clickable, no navigation), consistent with `"backup"` entries.

- [ ] **Step 16: Bump version**

In `src/config.js`, bump `APP_VERSION` to the next value after whatever it currently is (check the file first — do not assume a specific current value, other work may have shipped since this plan was written).

In `public/sw.js`, bump `SW_VERSION` to the same new value.

- [ ] **Step 17: Commit**

```bash
git add src/App.jsx src/config.js public/sw.js
git commit -m "$(cat <<'EOF'
Log family join/leave/removal events to the History tab

Backlog item 1. Written from the acting device's client only, at each
of the 9 validateMember/leaveFamily/removeFamilyMember call sites --
not from the realtime duvia-invite-left detection path, which would
have caused every connected family member's client to independently
insert a duplicate row into the shared history table.

Known gap, not addressed here: a departure caused by account deletion
(server-side, no client action) is not logged.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** all three event types (join/leave/removed) from the spec are covered — join: Steps 2, 3, 6. Leave: Steps 7, 10, 11. Removed: Steps 4, 8, 9. That's 3+3+3 = 9 sites, matching the spec's count. `TYPE_ICON`/`TYPE_LABEL` addition → Step 12. Test/build → Steps 13-14. Manual verification → Step 15. Version bump → Step 16.
- **Placeholder scan:** no TBD/TODO; every step shows the exact current code and its exact replacement.
- **Type consistency:** the `addHist(action, detail, type)` call shape is identical across all 9 sites (`action` string, empty `detail`, `"family"` type) — no drift between sites. Variable names used for `who` are whatever's already idiomatic at each specific site (matches the existing local variable naming already in that code, not a new shared helper — deliberately not introducing a shared `computeWho()` utility for 9 sites with 9 different available shapes of data, per YAGNI).
- **Line-number staleness risk:** every step's "find this exact block" snippet is long enough (multiple lines of surrounding code) to remain locatable via search even if exact line numbers have shifted slightly since this plan was written (same-day work). If a snippet doesn't match at all, treat as BLOCKED per the implementer's standing instructions, not a guess-and-proceed situation.
