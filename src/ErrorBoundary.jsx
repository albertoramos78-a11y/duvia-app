// src/ErrorBoundary.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Filet de sécurité au niveau racine : sans ceci, un plantage au rendu
// N'IMPORTE OÙ dans l'app démonte tout l'arbre React et laisse un écran
// blanc total, sans aucun moyen d'interagir — y compris pour signaler le
// problème, puisque le menu "Signaler un problème" fait lui-même partie de
// l'app qui vient de planter.
//
// 🔧 Volontairement sans AUCUNE dépendance à App.jsx, au thème, ou à
// useApp() : cet écran doit pouvoir s'afficher correctement même si c'est
// précisément l'état de l'app (contexte, session, thème) qui a causé le
// plantage. Il ne réutilise que logError/submitBugReport de diagnostics.js,
// qui ne dépendent d'aucun état React.
//
// Limites connues (normales pour un Error Boundary React, pas des bugs) :
// ne rattrape pas une erreur survenant avant que React ne démarre, ni une
// erreur dans un gestionnaire d'évènement (onClick, etc. — déjà couvert
// séparément par window.addEventListener("error"/"unhandledrejection")
// dans initDiagnostics()).
// ─────────────────────────────────────────────────────────────────────────────
import { Component } from "react";
import { logError, submitBugReport } from "./services/diagnostics";

const STYLES = {
  wrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "#f5f5f5", fontFamily: "-apple-system, sans-serif" },
  card: { maxWidth: 360, width: "100%", textAlign: "center", background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 4px 24px rgba(0,0,0,.08)" },
  icon: { fontSize: 40, marginBottom: 12 },
  title: { fontSize: 17, fontWeight: 800, color: "#222", marginBottom: 8 },
  desc: { fontSize: 13, color: "#666", lineHeight: 1.6, marginBottom: 22 },
  btnPrimary: { width: "100%", height: 44, background: "linear-gradient(135deg,#7BA8F5,#9D8FF0)", color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 14, marginBottom: 10, cursor: "pointer" },
  btnSecondary: { width: "100%", height: 40, background: "transparent", color: "#666", border: "1.5px solid #ddd", borderRadius: 12, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  status: { fontSize: 12, color: "#666", marginTop: 12 },
};

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, sending: false, sent: false };
  }

  // 🔧 hasError est un booléen dédié, pas juste "error est truthy" : un
  // composant qui fait `throw undefined`/`throw null`/`throw 0` (rare mais
  // possible) donnerait un `error` falsy, et render() retomberait sur
  // `this.props.children` — c'est-à-dire exactement l'écran blanc que ce
  // composant existe pour éviter.
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    logError(error?.message || "Erreur de rendu", error?.stack, { componentStack: errorInfo?.componentStack });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReport = async () => {
    this.setState({ sending: true });
    let email = null;
    try { email = JSON.parse(window.localStorage.getItem("duvia_session") || "null"); } catch { /* noop */ }
    try {
      await submitBugReport({
        comment: `[Plantage automatique] ${this.state.error?.message || "Erreur inconnue"}${email ? " — compte: " + email : ""}`,
        screenshot: null,
        context: { userId: null, familyId: null, screen: "crash", appState: {} },
      });
      this.setState({ sent: true, sending: false });
    } catch {
      this.setState({ sent: "error", sending: false });
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={STYLES.wrap}>
        <div style={STYLES.card}>
          <div style={STYLES.icon}>⚠️</div>
          <div style={STYLES.title}>Une erreur est survenue</div>
          <div style={STYLES.desc}>Duvia a rencontré un problème inattendu. Vous pouvez recharger l'application, ou nous signaler ce problème pour qu'on puisse le corriger.</div>
          <button onClick={this.handleReload} style={STYLES.btnPrimary}>🔄 Recharger l'application</button>
          <button onClick={this.handleReport} disabled={this.state.sending || this.state.sent === true} style={STYLES.btnSecondary}>
            {this.state.sending ? "Envoi…" : this.state.sent === true ? "✅ Signalé" : "🐛 Signaler ce problème"}
          </button>
          {this.state.sent === true && <div style={STYLES.status}>Merci, le problème a été transmis.</div>}
          {this.state.sent === "error" && <div style={STYLES.status}>L'envoi a échoué. Réessayez, ou rechargez l'application.</div>}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
