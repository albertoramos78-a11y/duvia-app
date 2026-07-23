import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import {
  type PensionConfig,
  type PensionPayment,
  dbToPensionConfig,
  dbToPensionPayment,
  listPensionConfigs,
  listPensionPayments,
  proposePensionConfig as proposePensionConfigApi,
  confirmPensionConfig as confirmPensionConfigApi,
  cancelPensionConfig as cancelPensionConfigApi,
  requestEndPensionConfig as requestEndPensionConfigApi,
  confirmEndPensionConfig as confirmEndPensionConfigApi,
  cancelEndPensionConfig as cancelEndPensionConfigApi,
  markPensionPaymentPaid as markPensionPaymentPaidApi,
  confirmPensionPayment as confirmPensionPaymentApi,
  contestPensionPayment as contestPensionPaymentApi,
} from "../services/supabase/pensionService";

/**
 * Configuration + versements de pension alimentaire. Entièrement séparé du
 * solde des dépenses partagées (useExpenses) — jamais mélangé.
 */
export function usePension(familyId: string | null) {
  const [configs, setConfigs] = useState<PensionConfig[]>([]);
  const [payments, setPayments] = useState<PensionPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!familyId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [cfgs, pmts] = await Promise.all([
        listPensionConfigs(familyId),
        listPensionPayments(familyId),
      ]);
      setConfigs(cfgs);
      setPayments(pmts);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Erreur de chargement de la pension");
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!familyId) return;

    const cfgChannel = supabase
      .channel(`pension_configs_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pension_configs", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToPensionConfig(payload.new);
            setConfigs((prev) => (prev.some((c) => c.id === incoming.id) ? prev : [incoming, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToPensionConfig(payload.new);
            setConfigs((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          } else if (payload.eventType === "DELETE") {
            setConfigs((prev) => prev.filter((c) => c.id !== payload.old.id));
          }
        }
      )
      .subscribe((status, err) => { console.log("[Duvia Realtime] pension_configs channel:", status, err); });

    const pmtChannel = supabase
      .channel(`pension_payments_${familyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pension_payments", filter: `family_id=eq.${familyId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const incoming = dbToPensionPayment(payload.new);
            setPayments((prev) => (prev.some((p) => p.id === incoming.id) ? prev : [incoming, ...prev]));
          } else if (payload.eventType === "UPDATE") {
            const updated = dbToPensionPayment(payload.new);
            setPayments((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          } else if (payload.eventType === "DELETE") {
            setPayments((prev) => prev.filter((p) => p.id !== payload.old.id));
          }
        }
      )
      .subscribe((status, err) => { console.log("[Duvia Realtime] pension_payments channel:", status, err); });

    return () => {
      supabase.removeChannel(cfgChannel);
      supabase.removeChannel(pmtChannel);
    };
  }, [familyId]);

  /** Propose une nouvelle configuration (statut "proposed"). */
  const proposePensionConfig = useCallback(async (params: Parameters<typeof proposePensionConfigApi>[0]) => {
    const created = await proposePensionConfigApi(params);
    setConfigs((prev) => (prev.some((c) => c.id === created.id) ? prev : [created, ...prev]));
    return created;
  }, []);

  /** Confirme une configuration proposée par l'AUTRE parent — non optimiste
   * (peut aussi clôturer une autre config active en une seule transaction
   * serveur), on relit simplement l'état après. */
  const confirmPensionConfig = useCallback(async (configId: string) => {
    await confirmPensionConfigApi(configId);
    await refresh();
  }, [refresh]);

  /** Annule/refuse une configuration encore 'proposed' — optimiste (simple
   * suppression), rollback via refresh() si l'appel serveur échoue. */
  const cancelPensionConfig = useCallback(async (configId: string) => {
    setConfigs((prev) => prev.filter((c) => c.id !== configId));
    try {
      await cancelPensionConfigApi(configId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  /** Demande la fin d'une pension active — non optimiste : la RPC renvoie la
   * ligne à jour (avec end_requested_by), on l'applique telle quelle plutôt
   * que de deviner l'état localement (une mise à jour "optimiste" qui
   * oubliait end_requested_by faisait voir au demandeur lui-même l'écran
   * "l'autre parent demande", le temps que le serveur réponde). */
  const requestEndPensionConfig = useCallback(async (configId: string) => {
    const updated = await requestEndPensionConfigApi(configId);
    setConfigs((prev) => prev.map((c) => (c.id === configId ? updated : c)));
  }, []);

  /** Confirme la fin (par l'AUTRE parent) — relit l'état après (clôture réelle). */
  const confirmEndPensionConfig = useCallback(async (configId: string) => {
    await confirmEndPensionConfigApi(configId);
    await refresh();
  }, [refresh]);

  /** Annule/refuse la demande de fin — optimiste, rollback via refresh() en cas d'échec. */
  const cancelEndPensionConfig = useCallback(async (configId: string) => {
    setConfigs((prev) => prev.map((c) => (c.id === configId ? { ...c, pendingEnd: false, endRequestedBy: null } : c)));
    try {
      await cancelEndPensionConfigApi(configId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  const markPensionPaymentPaid = useCallback(async (paymentId: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "marked_paid" as const } : p)));
    try {
      await markPensionPaymentPaidApi(paymentId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  const confirmPensionPayment = useCallback(async (paymentId: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "confirmed" as const } : p)));
    try {
      await confirmPensionPaymentApi(paymentId);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  const contestPensionPayment = useCallback(async (paymentId: string, note: string) => {
    setPayments((prev) => prev.map((p) => (p.id === paymentId ? { ...p, status: "contested" as const, note } : p)));
    try {
      await contestPensionPaymentApi(paymentId, note);
    } catch (err) {
      await refresh();
      throw err;
    }
  }, [refresh]);

  return {
    pensionConfigs: configs,
    pensionPayments: payments,
    pensionLoading: loading,
    pensionError: error,
    proposePensionConfig,
    confirmPensionConfig,
    cancelPensionConfig,
    requestEndPensionConfig,
    confirmEndPensionConfig,
    cancelEndPensionConfig,
    markPensionPaymentPaid,
    confirmPensionPayment,
    contestPensionPayment,
  };
}
