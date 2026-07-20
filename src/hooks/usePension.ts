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
      .subscribe();

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
      .subscribe();

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
    markPensionPaymentPaid,
    confirmPensionPayment,
    contestPensionPayment,
  };
}
