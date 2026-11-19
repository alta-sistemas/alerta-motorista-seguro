import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  EMPTY_PROFILE,
  DriverProfile,
  SavedLocation,
  getBestAvailableLocation,
  getProfileReadiness,
  isValidPhone,
  loadLastLocation,
  loadProfile,
  normalizeProfile,
  saveProfile,
} from "@/lib/panic";
import {
  AlertRole,
  DeviceIdentity,
  RemoteAlert,
  acknowledgeAlert,
  fetchInbox,
  getSecurityPushToken,
  getOverlayConfig,
  issueSecurityPairCode,
  loadIdentity,
  openOverlayPermission,
  pairDriver,
  registerDevice,
  resolveAlert,
  stopRemoteAlertTracking,
  triggerRemoteAlert,
} from "@/lib/alert-api";
import { configureOdinOverlay, consumeOdinOverlayTrigger, overlayHasPermission, overlaySupported, startOdinOverlay, stopOdinOverlayTracking } from "@/modules/odin-overlay";
import { startLiveLocationTracking, stopLiveLocationTracking } from "@/lib/live-location";
import { enqueueAlert, flushQueuedAlerts } from "@/lib/alert-queue";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
});

const PAPER = "#F7F8F5";
const CARD = "#FFFFFF";
const INK = "#172129";
const MUTED = "#768188";
const LINE = "#E1E5E3";
const AMBER = "#D49A3A";
const GREEN = "#2F8461";
const RED = "#C34F49";
const HOLD_MS = 1500;

type Notice = { tone: "success" | "warning" | "error"; text: string } | null;

type LocationSource = "current" | "last" | "none";

function locationLabel(location: SavedLocation | null, source: LocationSource): string {
  if (!location) return "indisponível";
  return `${source === "last" ? "última" : "atual"} · ${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}

function Field({ label, value, placeholder, onChangeText, keyboardType = "default", autoCapitalize = "sentences" }: { label: string; value: string; placeholder: string; onChangeText: (value: string) => void; keyboardType?: "default" | "phone-pad"; autoCapitalize?: "none" | "sentences" | "characters" }) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput autoCapitalize={autoCapitalize} keyboardType={keyboardType} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#A4ACAF" style={styles.input} value={value} />
    </View>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const color = notice.tone === "success" ? GREEN : notice.tone === "error" ? RED : AMBER;
  return <View style={[styles.notice, notice.tone === "success" && styles.noticeSuccess, notice.tone === "error" && styles.noticeError]}><Ionicons color={color} name={notice.tone === "success" ? "checkmark-circle-outline" : "information-circle-outline"} size={19} /><Text style={styles.noticeText}>{notice.text}</Text></View>;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [role, setRole] = useState<AlertRole>("driver");
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [profile, setProfile] = useState<DriverProfile>(EMPTY_PROFILE);
  const [draft, setDraft] = useState<DriverProfile>(EMPTY_PROFILE);
  const [lastLocation, setLastLocation] = useState<SavedLocation | null>(null);
  const [locationSource, setLocationSource] = useState<LocationSource>("none");
  const [configOpen, setConfigOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [alerts, setAlerts] = useState<RemoteAlert[]>([]);
  const [lastPoll, setLastPoll] = useState(0);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [pairCodeLoading, setPairCodeLoading] = useState(false);
  const [overlayActive, setOverlayActive] = useState(false);
  const [activeTracking, setActiveTracking] = useState<{ alertId: string } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdProgressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const readiness = useMemo(() => getProfileReadiness(profile), [profile]);
  const showNotice = useCallback((next: Notice) => {
    setNotice(next);
    if (next) setTimeout(() => setNotice(null), 5200);
  }, []);

  useEffect(() => {
    void Promise.all([loadProfile(), loadLastLocation()]).then(([savedProfile, savedLocation]) => {
      setProfile(savedProfile);
      setDraft(savedProfile);
      setLastLocation(savedLocation);
      if (savedLocation) setLocationSource("last");
    });
  }, []);

  useEffect(() => {
    let active = true;
    const flush = async () => {
      const delivered = await flushQueuedAlerts();
      if (active && delivered > 0) showNotice({ tone: "success", text: `${delivered} alerta${delivered > 1 ? "s" : ""} pendente${delivered > 1 ? "s foram reenviados" : " foi reenviado"}.` });
    };
    void flush();
    const timer = setInterval(() => void flush(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [showNotice]);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = async () => {
      const localIdentity = await loadIdentity(role, role === "security" ? "Central de segurança" : "Motorista");
      if (active && role === "security") setIdentity(localIdentity);
      try {
        const pushToken = role === "security" ? await getSecurityPushToken() : null;
        const remoteIdentity = await registerDevice({ ...localIdentity, pushToken });
        if (!active) return;
        setIdentity(remoteIdentity);
        setNotice(null);
      } catch {
        if (!active) return;
        if (role !== "security") setIdentity(null);
        showNotice({ tone: "warning", text: "Conectando à central… o aparelho tentará novamente automaticamente." });
        retryTimer = setTimeout(() => void connect(), 4000);
      }
    };
    void connect();
    return () => { active = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [role, showNotice]);

  useEffect(() => {
    if (role !== "security" || !identity) return;
    let active = true;
    const poll = async () => {
      try {
        const syncedIdentity = await registerDevice(identity);
        if (!active) return;
        if (syncedIdentity.pairCode !== identity.pairCode) setIdentity(syncedIdentity);
        const incoming = await fetchInbox(syncedIdentity, lastPoll);
        if (!active || incoming.length === 0) return;
        setAlerts((current) => {
          const updates = new Map(incoming.map((item) => [item.id, item]));
          return [...current.map((item) => updates.get(item.id) ?? item), ...incoming.filter((item) => !current.some((old) => old.id === item.id))].slice(0, 30);
        });
        const nextCursor = Math.max(...incoming.map((item) => item.updatedAt ?? item.createdAt), Date.now());
        setLastPoll(nextCursor);
        await AsyncStorage.setItem(`alerta.inbox.cursor.${syncedIdentity.deviceId}`, String(nextCursor));
        if (Platform.OS !== "web") {
          await Notifications.scheduleNotificationAsync({ content: { title: "ALERTA DE EMERGÊNCIA", body: `${incoming[0].driverName} pediu ajuda.`, data: { alertId: incoming[0].id, type: "emergency" } }, trigger: null });
        }
      } catch {
        // A central sem internet tenta novamente no próximo ciclo.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [identity, lastPoll, role]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let active = true;
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (active && response?.notification.request.content.data?.type === "emergency") setRole("security");
    });
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (active && response.notification.request.content.data?.type === "emergency") setRole("security");
    });
    return () => { active = false; subscription.remove(); };
  }, []);

  const requestSecurityNotifications = async () => {
    if (Platform.OS === "web") return;
    const result = await Notifications.requestPermissionsAsync();
    if (result.status !== "granted") showNotice({ tone: "warning", text: "Ative as notificações para a central avisar quando chegar um pedido." });
  };

  const updateDraft = (update: (current: DriverProfile) => DriverProfile) => setDraft((current) => update(current));

  const saveDriverProfile = async () => {
    const next = normalizeProfile(draft);
    const partial = next.contacts.some((contact) => (contact.name.trim() || contact.phone.trim()) && (!contact.name.trim() || !contact.phone.trim()));
    if (partial || next.contacts.some((contact) => contact.name.trim() && !isValidPhone(contact.phone))) {
      showNotice({ tone: "warning", text: "Complete nome e telefone de cada contato ou deixe o slot vazio." });
      return;
    }
    await saveProfile(next);
    setProfile(next);
    setDraft(next);
    setConfigOpen(false);
    showNotice({ tone: "success", text: "Dados salvos neste aparelho." });
  };

  const handlePanic = async () => {
    if (busy) return;
    if (!readiness.ready) {
      showNotice({ tone: "warning", text: "Complete um contato e os dados do veículo antes de testar o alerta." });
      setConfigOpen(true);
      return;
    }
    if (!identity) {
      showNotice({ tone: "warning", text: "Conectando ao servidor. Tente novamente em alguns segundos." });
      return;
    }
    setBusy(true);
    setHolding(false);
    const location = await getBestAvailableLocation();
    setLastLocation(location.location);
    setLocationSource(location.source);
    const alertId = `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    try {
      const result = await triggerRemoteAlert({ identity, driverName: "Motorista", vehicle: profile.vehicle, location: location.location ? { latitude: location.location.latitude, longitude: location.location.longitude } : null, locationSource: location.source, capturedAt: location.location?.capturedAt ?? new Date().toISOString(), alertId });
      showNotice({ tone: result.deliveredTo > 0 ? "success" : "warning", text: result.deliveredTo > 0 ? "Alerta enviado à central de segurança." : "Alerta registrado. Nenhuma central pareada está online agora." });
      try {
        const tracking = await startLiveLocationTracking(identity, result.alertId);
        if (tracking === "started") setActiveTracking({ alertId: result.alertId });
        else showNotice({ tone: "warning", text: "Alerta enviado, mas a localização contínua não foi autorizada." });
      } catch {
        showNotice({ tone: "warning", text: "Alerta enviado, mas não foi possível iniciar a localização contínua." });
      }
    } catch {
      await enqueueAlert({ alertId, identity, driverName: "Motorista", vehicle: profile.vehicle, location: location.location ? { latitude: location.location.latitude, longitude: location.location.longitude } : null, locationSource: location.source, capturedAt: location.location?.capturedAt ?? new Date().toISOString() });
      showNotice({ tone: "warning", text: "Sem conexão. O alerta foi salvo neste aparelho e será reenviado automaticamente." });
    } finally {
      setBusy(false);
      setHoldProgress(0);
    }
  };

  useEffect(() => {
    if (role !== "driver" || Platform.OS !== "android") {
      const timer = setTimeout(() => setOverlayActive(false), 0);
      return () => clearTimeout(timer);
    }
    if (!overlaySupported()) {
      const timer = setTimeout(() => {
        setOverlayActive(false);
        showNotice({ tone: "warning", text: "Esta instalação ainda não inclui o botão flutuante nativo do ODIN. Instale o APK ODIN atualizado." });
      }, 0);
      return () => clearTimeout(timer);
    }
    const syncOverlay = () => {
      const permitted = overlayHasPermission();
      setOverlayActive(permitted);
      if (permitted && identity) {
        configureOdinOverlay(getOverlayConfig(identity, profile.vehicle, "Motorista"));
        startOdinOverlay();
      }
    };
    const initialSync = setTimeout(syncOverlay, 0);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") syncOverlay();
    });
    let triggerBusy = false;
    const consumeTrigger = () => {
      if (triggerBusy || !consumeOdinOverlayTrigger()) return;
      triggerBusy = true;
      void handlePanic().finally(() => { triggerBusy = false; });
    };
    const triggerTimer = setInterval(consumeTrigger, 350);
    const firstTrigger = setTimeout(consumeTrigger, 500);
    return () => { clearTimeout(initialSync); clearTimeout(firstTrigger); clearInterval(triggerTimer); subscription.remove(); };
  // handlePanic is intentionally omitted: changing its closure must not restart the native overlay service.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, identity, profile, readiness.ready, showNotice]);

  const startHolding = () => {
    if (busy) return;
    setHolding(true);
    setHoldProgress(0);
    const startedAt = Date.now();
    holdProgressTimer.current = setInterval(() => setHoldProgress(Math.min(100, ((Date.now() - startedAt) / HOLD_MS) * 100)), 40);
    holdTimer.current = setTimeout(() => {
      if (holdProgressTimer.current) clearInterval(holdProgressTimer.current);
      void handlePanic();
    }, HOLD_MS);
  };

  const stopHolding = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (holdProgressTimer.current) clearInterval(holdProgressTimer.current);
    holdTimer.current = null;
    holdProgressTimer.current = null;
    setHolding(false);
    setHoldProgress(0);
  };

  const pairNow = async () => {
    if (!identity || !pairCodeInput.trim()) return;
    try {
      await pairDriver(identity, pairCodeInput);
      setPairCodeInput("");
      showNotice({ tone: "success", text: "Motorista vinculado à central. O próximo alerta chegará aqui." });
    } catch {
      showNotice({ tone: "error", text: "Código inválido ou expirado. Confira o código na central." });
    }
  };

  const generateSecurityCode = async () => {
    if (!identity || identity.role !== "security" || pairCodeLoading) return;
    setPairCodeLoading(true);
    try {
      const updated = await issueSecurityPairCode(identity);
      setIdentity(updated);
      showNotice({ tone: "success", text: "Novo código de pareamento gerado. Ele vale por 10 minutos." });
    } catch {
      showNotice({ tone: "error", text: "Não foi possível gerar o código. Verifique a conexão e tente novamente." });
    } finally {
      setPairCodeLoading(false);
    }
  };

  const stopTracking = async () => {
    if (!activeTracking || !identity) return;
    await stopLiveLocationTracking();
    stopOdinOverlayTracking();
    await stopRemoteAlertTracking(identity, activeTracking.alertId).catch(() => undefined);
    setActiveTracking(null);
    showNotice({ tone: "success", text: "Compartilhamento de localização encerrado." });
  };

  const openAlertMap = (alert: RemoteAlert) => {
    if (alert.latitude === null || alert.longitude === null) return;
    void Linking.openURL(`https://maps.google.com/?q=${alert.latitude},${alert.longitude}`);
  };

  const acknowledge = async (alert: RemoteAlert) => {
    if (!identity) return;
    await acknowledgeAlert(identity, alert.id);
    setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, status: "acknowledged" } : item));
  };

  const resolve = async (alert: RemoteAlert) => {
    if (!identity) return;
    await resolveAlert(identity, alert.id);
    setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, status: "resolved", trackingActive: false } : item));
    showNotice({ tone: "success", text: "Alerta encerrado e resolvido." });
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 18), paddingBottom: Math.max(insets.bottom, 24) + (role === "driver" ? 94 : 0) }]} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}><View style={styles.wordmarkRow}><View style={styles.wordmarkMark}><View style={styles.wordmarkDot} /></View><Text style={styles.wordmark}>ALERTA</Text></View><View style={styles.discreetPill}><View style={styles.discreetDot} /><Text style={styles.discreetText}>{role === "driver" ? "MODO MOTORISTA" : "MODO SEGURANÇA"}</Text></View></View>
        <View style={styles.roleSwitch}><Pressable onPress={() => setRole("driver")} style={[styles.roleButton, role === "driver" && styles.roleButtonActive]}><Ionicons color={role === "driver" ? INK : MUTED} name="car-outline" size={17} /><Text style={[styles.roleButtonText, role === "driver" && styles.roleButtonTextActive]}>Motorista</Text></Pressable><Pressable onPress={() => { setRole("security"); void requestSecurityNotifications(); }} style={[styles.roleButton, role === "security" && styles.roleButtonActive]}><Ionicons color={role === "security" ? INK : MUTED} name="shield-checkmark-outline" size={17} /><Text style={[styles.roleButtonText, role === "security" && styles.roleButtonTextActive]}>Segurança</Text></Pressable></View>
        <NoticeBanner notice={notice} />
        {role === "driver" ? <DriverView activeTracking={activeTracking !== null} onStopTracking={() => void stopTracking()} profile={profile} readiness={readiness} lastLocation={lastLocation} locationSource={locationSource} busy={busy} holding={holding} holdProgress={holdProgress} identity={identity} onOpenConfig={() => { setDraft(normalizeProfile(profile)); setConfigOpen(true); }} onOpenOverlay={() => { void openOverlayPermission(); setTimeout(() => { if (identity && overlayHasPermission()) { configureOdinOverlay(getOverlayConfig(identity, profile.vehicle, "Motorista")); startOdinOverlay(); } }, 1500); }} onStartHolding={startHolding} onStopHolding={stopHolding} pairCodeInput={pairCodeInput} onPairCodeChange={setPairCodeInput} onPair={pairNow} /> : <SecurityView identity={identity} alerts={alerts} loading={securityLoading} pairCodeLoading={pairCodeLoading} onGenerateCode={() => void generateSecurityCode()} onRefresh={async () => { setSecurityLoading(true); if (identity) setAlerts(await fetchInbox(identity, 0).catch(() => alerts)); setSecurityLoading(false); }} onOpenMap={openAlertMap} onAcknowledge={acknowledge} onResolve={resolve} />}
        <Text style={styles.disclaimer}>O Alerta não substitui os serviços oficiais de emergência. Em risco imediato, ligue 190.</Text>
      </ScrollView>
      {role === "driver" && !overlayActive ? <FloatingPanicButton busy={busy} holdProgress={holdProgress} holding={holding} onStartHolding={startHolding} onStopHolding={stopHolding} /> : null}
      <Modal animationType="slide" onRequestClose={() => setConfigOpen(false)} transparent visible={configOpen}><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}><View style={[styles.modalCard, { paddingBottom: Math.max(insets.bottom, 18) }]}><View style={styles.modalHandle} /><View style={styles.modalHeader}><View><Text style={styles.modalKicker}>CONFIGURAÇÃO LOCAL</Text><Text style={styles.modalTitle}>Perfil do motorista</Text></View><Pressable onPress={() => setConfigOpen(false)} style={styles.closeButton}><Ionicons color={INK} name="close" size={22} /></Pressable></View><ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled"><Text style={styles.modalSectionTitle}>Seu veículo</Text><Field label="Modelo" onChangeText={(value) => updateDraft((current) => ({ ...current, vehicle: { ...current.vehicle, model: value } }))} placeholder="Onix 1.0" value={draft.vehicle.model} /><View style={styles.twoFields}><View style={styles.halfField}><Field label="Cor" onChangeText={(value) => updateDraft((current) => ({ ...current, vehicle: { ...current.vehicle, color: value } }))} placeholder="Prata" value={draft.vehicle.color} /></View><View style={styles.halfField}><Field autoCapitalize="characters" label="Placa" onChangeText={(value) => updateDraft((current) => ({ ...current, vehicle: { ...current.vehicle, plate: value } }))} placeholder="ABC1D23" value={draft.vehicle.plate} /></View></View><Text style={[styles.modalSectionTitle, { marginTop: 16 }]}>Contatos de emergência</Text>{draft.contacts.map((contact, index) => <View key={contact.id} style={styles.contactBlock}><View style={styles.contactNumber}><Text style={styles.contactNumberText}>{index + 1}</Text></View><View style={styles.contactFields}><Field label={`Nome ${index + 1}`} onChangeText={(value) => updateDraft((current) => ({ ...current, contacts: current.contacts.map((item) => item.id === contact.id ? { ...item, name: value } : item) }))} placeholder="Pessoa de confiança" value={contact.name} /><Field keyboardType="phone-pad" label="Telefone" onChangeText={(value) => updateDraft((current) => ({ ...current, contacts: current.contacts.map((item) => item.id === contact.id ? { ...item, phone: value } : item) }))} placeholder="(11) 99999-9999" value={contact.phone} /><Pressable onPress={() => updateDraft((current) => ({ ...current, contacts: current.contacts.map((item) => item.id === contact.id ? { ...item, name: "", phone: "" } : item) }))}><Text style={styles.clearContactText}>Limpar contato</Text></Pressable></View></View>)}<Pressable onPress={() => void saveDriverProfile()} style={styles.primaryButton}><Ionicons color={INK} name="save-outline" size={18} /><Text style={styles.primaryButtonText}>Salvar perfil</Text></Pressable></ScrollView></View></KeyboardAvoidingView></Modal>
    </View>
  );
}

function FloatingPanicButton({ busy, holding, holdProgress, onStartHolding, onStopHolding }: { busy: boolean; holding: boolean; holdProgress: number; onStartHolding: () => void; onStopHolding: () => void }) {
  return <View pointerEvents="box-none" style={styles.floatingDock}><Pressable accessibilityLabel="Pressionar e segurar o atalho discreto para pedir ajuda" disabled={busy} onPressIn={onStartHolding} onPressOut={onStopHolding} style={[styles.floatingButton, holding && styles.floatingButtonHolding, busy && styles.floatingButtonBusy]}><View style={[styles.floatingProgress, { width: `${holdProgress}%` }]} />{busy ? <ActivityIndicator color="#F8F8F4" size="small" /> : <Ionicons color="#F8F8F4" name="radio-outline" size={20} />}</Pressable><Text style={styles.floatingHint}>segure</Text></View>;
}

function DriverView({ activeTracking, onStopTracking, profile, readiness, lastLocation, locationSource, busy, holding, holdProgress, identity, onOpenConfig, onOpenOverlay, onStartHolding, onStopHolding, pairCodeInput, onPairCodeChange, onPair }: { activeTracking: boolean; onStopTracking: () => void; profile: DriverProfile; readiness: ReturnType<typeof getProfileReadiness>; lastLocation: SavedLocation | null; locationSource: LocationSource; busy: boolean; holding: boolean; holdProgress: number; identity: DeviceIdentity | null; onOpenConfig: () => void; onOpenOverlay: () => void; onStartHolding: () => void; onStopHolding: () => void; pairCodeInput: string; onPairCodeChange: (value: string) => void; onPair: () => void }) {
  return <><View style={styles.introRow}><View style={styles.introCopy}><Text style={styles.eyebrow}>ASSISTÊNCIA DE ROTA</Text><Text style={styles.title}>Ajuda sem abrir mensagens.</Text><Text style={styles.subtitle}>O alerta vai direto para a central de segurança pela internet.</Text></View><View style={styles.routeIcon}><Ionicons color={AMBER} name="radio-outline" size={25} /></View></View><View style={styles.statusGrid}><StatusChip good={readiness.contacts > 0} icon="people-outline" label="CONTATOS" value={`${readiness.contacts} prontos`} /><StatusChip good={readiness.hasVehicle} icon="car-outline" label="VEÍCULO" value={readiness.hasVehicle ? `${profile.vehicle.model} · ${profile.vehicle.plate}` : "pendente"} /><StatusChip good={Boolean(lastLocation)} icon="location-outline" label="LOCALIZAÇÃO" value={locationLabel(lastLocation, locationSource)} /></View>{activeTracking ? <View style={styles.trackingCard}><View style={styles.cardIconSmall}><Ionicons color={GREEN} name="navigate-outline" size={20} /></View><View style={styles.profileCardCopy}><Text style={styles.cardMiniTitle}>Localização compartilhada em tempo real</Text><Text style={styles.profileCardBody}>A central está recebendo sua posição enquanto este alerta estiver ativo.</Text><Pressable onPress={onStopTracking} style={styles.stopTrackingButton}><Text style={styles.stopTrackingText}>Encerrar compartilhamento</Text></Pressable></View></View> : null}<Pressable onPress={onOpenConfig} style={styles.profileCard}><View style={styles.profileCardIcon}><Ionicons color={AMBER} name="shield-checkmark-outline" size={23} /></View><View style={styles.profileCardCopy}><Text style={styles.profileCardTitle}>{readiness.ready ? "Perfil pronto" : "Finalize sua configuração"}</Text><Text style={styles.profileCardBody}>{readiness.ready ? "Você pode pedir ajuda sem abrir mensagens." : "Cadastre um contato e os dados do carro."}</Text></View><Ionicons color="#9AA5AA" name="chevron-forward" size={19} /></Pressable><Pressable onPress={onOpenOverlay} style={styles.overlayCard}><View style={styles.cardIconSmall}><Ionicons color={AMBER} name="layers-outline" size={20} /></View><View style={styles.profileCardCopy}><Text style={styles.cardMiniTitle}>Atalho sobre outras telas</Text><Text style={styles.profileCardBody}>No Android, permita “sobrepor a outros apps” para manter o atalho disponível.</Text></View><Ionicons color="#9AA5AA" name="chevron-forward" size={19} /></Pressable><View style={styles.pairCard}><View style={styles.cardIconSmall}><Ionicons color={AMBER} name="link-outline" size={20} /></View><View style={styles.profileCardCopy}><Text style={styles.cardMiniTitle}>Vincular à central</Text><Text style={styles.profileCardBody}>Digite o código mostrado no celular da pessoa de segurança.</Text><View style={styles.inlineRow}><TextInput keyboardType="number-pad" maxLength={6} onChangeText={onPairCodeChange} placeholder="000000" placeholderTextColor="#A4ACAF" style={styles.codeInput} value={pairCodeInput} /><Pressable onPress={onPair} style={styles.smallButton}><Text style={styles.smallButtonText}>Vincular</Text></Pressable></View></View></View></>;
}

function SecurityView({ identity, alerts, loading, pairCodeLoading, onGenerateCode, onRefresh, onOpenMap, onAcknowledge, onResolve }: { identity: DeviceIdentity | null; alerts: RemoteAlert[]; loading: boolean; pairCodeLoading: boolean; onGenerateCode: () => void; onRefresh: () => Promise<void>; onOpenMap: (alert: RemoteAlert) => void; onAcknowledge: (alert: RemoteAlert) => Promise<void>; onResolve: (alert: RemoteAlert) => Promise<void> }) {
  return <><View style={styles.introRow}><View style={styles.introCopy}><Text style={styles.eyebrow}>CENTRAL DE SEGURANÇA</Text><Text style={styles.title}>Pedidos de ajuda, em primeiro plano.</Text><Text style={styles.subtitle}>Mantenha este modo conectado para receber os alertas dos motoristas.</Text></View><View style={styles.routeIcon}><Ionicons color={AMBER} name="shield-checkmark-outline" size={25} /></View></View><View style={styles.codeCard}><Text style={styles.cardKicker}>CÓDIGO DE PAREAMENTO</Text><Text style={styles.pairCode}>{identity?.pairCode ?? "------"}</Text><Text style={styles.actionHint}>{identity?.pairCode ? "No celular do motorista, escolha Motorista e digite este código." : "Toque abaixo para gerar um código para o motorista."}</Text><Pressable disabled={pairCodeLoading || !identity} onPress={onGenerateCode} style={styles.generateCodeButton}><Text style={styles.generateCodeText}>{pairCodeLoading ? "Gerando…" : identity?.pairCode ? "Gerar novo código" : "Gerar código"}</Text></Pressable></View><View style={styles.sectionHeader}><View><Text style={styles.sectionKicker}>INBOX DE EMERGÊNCIA</Text><Text style={styles.sectionTitle}>{alerts.length ? `${alerts.length} alerta${alerts.length > 1 ? "s" : ""}` : "Nenhum alerta"}</Text></View><Pressable disabled={loading} onPress={() => void onRefresh()} style={styles.refreshButton}><Ionicons color={INK} name="refresh-outline" size={17} /><Text style={styles.editButtonText}>Atualizar</Text></Pressable></View>{alerts.length === 0 ? <View style={styles.emptyCard}><Ionicons color="#B9C1C0" name="notifications-off-outline" size={28} /><Text style={styles.emptyTitle}>Central em escuta</Text><Text style={styles.emptyBody}>Quando um motorista pedir ajuda, o alerta aparecerá aqui com localização e dados do veículo.</Text></View> : alerts.map((alert) => <View key={alert.id} style={[styles.alertCard, alert.status !== "new" && styles.alertCardDone]}><View style={styles.alertHeader}><View style={styles.alertIcon}><Ionicons color={RED} name="warning-outline" size={21} /></View><View style={styles.profileCardCopy}><Text style={styles.alertTitle}>{alert.driverName} pediu ajuda</Text><Text style={styles.alertTime}>{new Date(alert.capturedAt).toLocaleString("pt-BR")}</Text></View><View style={styles.newBadge}><Text style={styles.newBadgeText}>{alert.status === "new" ? "NOVO" : "VISTO"}</Text></View></View><Text style={styles.alertVehicle}>{alert.vehicle.model || "Veículo"} · {alert.vehicle.color || "cor não informada"} · {alert.vehicle.plate || "placa não informada"}</Text><Text style={styles.alertLocation}>{alert.latitude === null ? "Localização indisponível" : `${alert.locationSource === "last" ? "Última localização" : "Localização atual"}: ${alert.latitude.toFixed(5)}, ${alert.longitude?.toFixed(5)}`}</Text><Text style={styles.alertLocation}>Rastreamento: {alert.trackingActive ? "ativo" : "encerrado"}</Text><View style={styles.alertActions}>{alert.latitude !== null ? <Pressable onPress={() => onOpenMap(alert)} style={styles.secondaryButton}><Ionicons color={INK} name="map-outline" size={17} /><Text style={styles.secondaryButtonText}>Abrir mapa</Text></Pressable> : null}<Pressable onPress={() => void onAcknowledge(alert)} style={styles.secondaryButton}><Ionicons color={GREEN} name="checkmark-outline" size={17} /><Text style={styles.secondaryButtonText}>Assumir alerta</Text></Pressable><Pressable onPress={() => void onResolve(alert)} style={styles.secondaryButton}><Ionicons color={RED} name="close-circle-outline" size={17} /><Text style={styles.secondaryButtonText}>{alert.status === "resolved" ? "Resolvido" : "Encerrar alerta"}</Text></Pressable></View></View>)}</>;
}

function StatusChip({ icon, label, value, good }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; good: boolean }) { return <View style={styles.statusChip}><Ionicons color={good ? GREEN : AMBER} name={icon} size={17} /><View style={styles.statusChipCopy}><Text style={styles.statusChipLabel}>{label}</Text><Text numberOfLines={1} style={[styles.statusChipValue, good && styles.statusChipGood]}>{value}</Text></View></View>; }

const styles = StyleSheet.create({
  trackingCard: { alignItems: "flex-start", backgroundColor: "#EEF7F2", borderColor: "#CDE7D9", borderRadius: 17, borderWidth: 1, flexDirection: "row", marginBottom: 10, padding: 14 },
  stopTrackingButton: { alignSelf: "flex-start", borderColor: "#A9D1BC", borderRadius: 9, borderWidth: 1, marginTop: 10, paddingHorizontal: 10, paddingVertical: 7 },
  stopTrackingText: { color: GREEN, fontSize: 11, fontWeight: "800" },
  screen: { flex: 1, backgroundColor: PAPER }, content: { paddingHorizontal: 20 },
  topBar: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  wordmarkRow: { alignItems: "center", flexDirection: "row", gap: 10 }, wordmarkMark: { alignItems: "center", backgroundColor: INK, borderRadius: 8, height: 31, justifyContent: "center", width: 31 }, wordmarkDot: { backgroundColor: AMBER, borderRadius: 5, height: 10, width: 10 }, wordmark: { color: INK, fontSize: 15, fontWeight: "800", letterSpacing: 2.1 }, discreetPill: { alignItems: "center", backgroundColor: "#EDEFEA", borderRadius: 14, flexDirection: "row", gap: 7, paddingHorizontal: 10, paddingVertical: 7 }, discreetDot: { backgroundColor: GREEN, borderRadius: 4, height: 7, width: 7 }, discreetText: { color: MUTED, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  roleSwitch: { backgroundColor: "#E9ECE9", borderRadius: 15, flexDirection: "row", marginBottom: 24, padding: 4 }, roleButton: { alignItems: "center", borderRadius: 12, flex: 1, flexDirection: "row", gap: 7, justifyContent: "center", paddingVertical: 10 }, roleButtonActive: { backgroundColor: CARD, elevation: 1 }, roleButtonText: { color: MUTED, fontSize: 12, fontWeight: "700" }, roleButtonTextActive: { color: INK },
  introRow: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between", marginBottom: 22 }, introCopy: { flex: 1, paddingRight: 18 }, eyebrow: { color: AMBER, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 }, title: { color: INK, fontSize: 29, fontWeight: "800", letterSpacing: -0.8, lineHeight: 34 }, subtitle: { color: MUTED, fontSize: 14, lineHeight: 20, marginTop: 8 }, routeIcon: { alignItems: "center", backgroundColor: "#FFF7E8", borderColor: "#F3E2BE", borderRadius: 18, borderWidth: 1, height: 52, justifyContent: "center", width: 52 },
  notice: { alignItems: "flex-start", backgroundColor: "#FFF7E8", borderColor: "#F0DFBD", borderRadius: 13, borderWidth: 1, flexDirection: "row", gap: 9, marginBottom: 14, padding: 12 }, noticeSuccess: { backgroundColor: "#EEF7F2", borderColor: "#CDE7D9" }, noticeError: { backgroundColor: "#FFF0EF", borderColor: "#F0CACA" }, noticeText: { color: INK, flex: 1, fontSize: 12, lineHeight: 17 },
  actionCard: { display: "none" }, actionHeader: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" }, cardKicker: { color: AMBER, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }, actionTitle: { color: INK, fontSize: 22, fontWeight: "800", marginTop: 5 }, lockBadge: { alignItems: "center", backgroundColor: "#F2F3F1", borderRadius: 15, height: 30, justifyContent: "center", width: 30 }, actionHint: { color: MUTED, fontSize: 12, lineHeight: 17, marginTop: 5 }, panicButtonWrap: { alignItems: "center", justifyContent: "center", marginVertical: 20 }, panicRing: { alignItems: "center", borderColor: "#EADFCB", borderRadius: 91, borderWidth: 1, height: 182, justifyContent: "center", width: 182 }, panicRingHolding: { borderColor: AMBER, borderWidth: 3 }, panicButton: { alignItems: "center", backgroundColor: AMBER, borderRadius: 72, elevation: 3, height: 144, justifyContent: "center", width: 144 }, panicButtonBusy: { backgroundColor: "#D9B775" }, panicButtonText: { color: INK, fontSize: 11, fontWeight: "900", letterSpacing: 1.1, marginTop: 7 }, progressTrack: { backgroundColor: "#F0F1EF", borderRadius: 3, height: 5, overflow: "hidden", width: "100%" }, progressFill: { backgroundColor: AMBER, borderRadius: 3, height: "100%" }, actionFootnote: { color: MUTED, fontSize: 11, lineHeight: 16, marginTop: 10, textAlign: "center" },
  statusGrid: { flexDirection: "row", gap: 8, marginBottom: 16 }, statusChip: { alignItems: "flex-start", backgroundColor: "#ECEFEC", borderRadius: 13, flex: 1, flexDirection: "row", gap: 7, minHeight: 68, padding: 10 }, statusChipCopy: { flex: 1 }, statusChipLabel: { color: MUTED, fontSize: 9, fontWeight: "800", letterSpacing: 0.7 }, statusChipValue: { color: INK, fontSize: 11, fontWeight: "700", marginTop: 4 }, statusChipGood: { color: GREEN }, profileCard: { alignItems: "center", backgroundColor: CARD, borderColor: LINE, borderRadius: 17, borderWidth: 1, flexDirection: "row", marginBottom: 10, padding: 14 }, overlayCard: { alignItems: "center", backgroundColor: "#ECEFEC", borderRadius: 17, flexDirection: "row", marginBottom: 10, padding: 14 }, profileCardIcon: { alignItems: "center", backgroundColor: "#FFF7E8", borderRadius: 12, height: 43, justifyContent: "center", marginRight: 12, width: 43 }, profileCardCopy: { flex: 1 }, profileCardTitle: { color: INK, fontSize: 14, fontWeight: "800" }, profileCardBody: { color: MUTED, fontSize: 12, lineHeight: 17, marginTop: 3 },
  pairCard: { alignItems: "flex-start", backgroundColor: "#ECEFEC", borderRadius: 17, flexDirection: "row", marginBottom: 22, padding: 14 }, cardIconSmall: { alignItems: "center", backgroundColor: "#F7F8F6", borderRadius: 12, height: 41, justifyContent: "center", marginRight: 12, width: 41 }, cardMiniTitle: { color: INK, fontSize: 13, fontWeight: "800" }, inlineRow: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 10 }, codeInput: { backgroundColor: CARD, borderColor: LINE, borderRadius: 10, borderWidth: 1, color: INK, flex: 1, fontSize: 16, fontWeight: "800", height: 42, letterSpacing: 2, paddingHorizontal: 12 }, smallButton: { alignItems: "center", backgroundColor: AMBER, borderRadius: 10, height: 42, justifyContent: "center", paddingHorizontal: 12 }, smallButtonText: { color: INK, fontSize: 11, fontWeight: "900" },
  codeCard: { backgroundColor: INK, borderRadius: 20, marginBottom: 24, padding: 20 }, pairCode: { color: "#FFFFFF", fontSize: 38, fontWeight: "900", letterSpacing: 7, marginVertical: 8 }, generateCodeButton: { alignItems: "center", alignSelf: "flex-start", backgroundColor: AMBER, borderRadius: 10, marginTop: 12, paddingHorizontal: 13, paddingVertical: 9 }, generateCodeText: { color: INK, fontSize: 11, fontWeight: "900" }, sectionHeader: { alignItems: "flex-end", flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }, sectionKicker: { color: AMBER, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }, sectionTitle: { color: INK, fontSize: 21, fontWeight: "800", marginTop: 4 }, refreshButton: { alignItems: "center", flexDirection: "row", gap: 5, padding: 5 }, editButtonText: { color: INK, fontSize: 12, fontWeight: "700" }, emptyCard: { alignItems: "center", backgroundColor: CARD, borderColor: LINE, borderRadius: 18, borderWidth: 1, marginBottom: 22, padding: 26 }, emptyTitle: { color: INK, fontSize: 15, fontWeight: "800", marginTop: 10 }, emptyBody: { color: MUTED, fontSize: 12, lineHeight: 18, marginTop: 5, textAlign: "center" },
  alertCard: { backgroundColor: CARD, borderColor: "#EFC7C2", borderRadius: 18, borderWidth: 1, marginBottom: 12, padding: 15 }, alertCardDone: { borderColor: LINE, opacity: 0.78 }, alertHeader: { alignItems: "center", flexDirection: "row" }, alertIcon: { alignItems: "center", backgroundColor: "#FFF0EF", borderRadius: 12, height: 40, justifyContent: "center", marginRight: 11, width: 40 }, alertTitle: { color: INK, fontSize: 14, fontWeight: "800" }, alertTime: { color: MUTED, fontSize: 11, marginTop: 3 }, newBadge: { backgroundColor: "#FFF0EF", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5 }, newBadgeText: { color: RED, fontSize: 9, fontWeight: "900" }, alertVehicle: { color: INK, fontSize: 12, fontWeight: "700", marginTop: 14 }, alertLocation: { color: MUTED, fontSize: 11, lineHeight: 16, marginTop: 5 }, alertActions: { flexDirection: "row", gap: 8, marginTop: 13 }, secondaryButton: { alignItems: "center", borderColor: LINE, borderRadius: 10, borderWidth: 1, flex: 1, flexDirection: "row", gap: 6, height: 40, justifyContent: "center" }, secondaryButtonText: { color: INK, fontSize: 11, fontWeight: "800" }, disclaimer: { color: "#899399", fontSize: 10, lineHeight: 15, marginBottom: 12, paddingHorizontal: 5, textAlign: "center" },
  modalBackdrop: { backgroundColor: "rgba(17, 24, 30, 0.42)", flex: 1, justifyContent: "flex-end" }, modalCard: { backgroundColor: PAPER, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: "93%", paddingHorizontal: 20, paddingTop: 10 }, modalHandle: { alignSelf: "center", backgroundColor: "#CDD3D5", borderRadius: 3, height: 5, marginBottom: 18, width: 42 }, modalHeader: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between", marginBottom: 18 }, modalKicker: { color: AMBER, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }, modalTitle: { color: INK, fontSize: 25, fontWeight: "800", marginTop: 4 }, closeButton: { alignItems: "center", backgroundColor: "#E8EBE9", borderRadius: 17, height: 34, justifyContent: "center", width: 34 }, modalScroll: { paddingBottom: 16 }, modalSectionTitle: { color: INK, fontSize: 14, fontWeight: "800", marginBottom: 12, marginTop: 4 }, fieldGroup: { marginBottom: 12 }, fieldLabel: { color: MUTED, fontSize: 10, fontWeight: "800", letterSpacing: 0.4, marginBottom: 6 }, input: { backgroundColor: CARD, borderColor: LINE, borderRadius: 11, borderWidth: 1, color: INK, fontSize: 14, height: 46, paddingHorizontal: 13 }, twoFields: { flexDirection: "row", gap: 10 }, halfField: { flex: 1 }, contactBlock: { alignItems: "flex-start", flexDirection: "row", marginBottom: 3 }, contactNumber: { alignItems: "center", backgroundColor: "#ECEFEC", borderRadius: 9, height: 29, justifyContent: "center", marginRight: 10, marginTop: 22, width: 29 }, contactNumberText: { color: AMBER, fontSize: 11, fontWeight: "900" }, contactFields: { flex: 1 }, clearContactText: { color: RED, fontSize: 11, fontWeight: "700", marginBottom: 10 }, primaryButton: { alignItems: "center", backgroundColor: AMBER, borderRadius: 13, flexDirection: "row", gap: 8, height: 52, justifyContent: "center", marginTop: 8 }, primaryButtonText: { color: INK, fontSize: 13, fontWeight: "900" }, floatingDock: { alignItems: "center", bottom: 18, position: "absolute", right: 18, zIndex: 10 }, floatingButton: { alignItems: "center", backgroundColor: "#35444A", borderColor: "#6A777A", borderRadius: 28, borderWidth: 1, elevation: 5, height: 56, justifyContent: "center", overflow: "hidden", shadowColor: "#172129", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.18, shadowRadius: 6, width: 56 }, floatingButtonHolding: { backgroundColor: "#465158", borderColor: AMBER, borderWidth: 2 }, floatingButtonBusy: { backgroundColor: "#697475" }, floatingProgress: { backgroundColor: "rgba(212,154,58,0.52)", bottom: 0, left: 0, position: "absolute", right: 0 }, floatingHint: { color: MUTED, fontSize: 9, fontWeight: "800", letterSpacing: 0.7, marginTop: 4, textTransform: "uppercase" },
});
