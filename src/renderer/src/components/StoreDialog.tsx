import { useEffect, useMemo, useRef, useState } from "react";
import { getLocale, t, tn, type Key } from "@shared/i18n";
import {
  localize,
  STORE_CATEGORIES,
  storeGroups,
  storeLanguages,
  type StoreEntry,
  type StoreGroup,
  type StoreItemType,
  type StoreState,
  type StoreView,
} from "@shared/store";
import { useKnowledge } from "../store/useKnowledge";
import { useRoles } from "../store/useRoles";
import { DialogClose } from "./IconButton";
import { BookOpenIcon, IdCardIcon, PackageIcon, PuzzleIcon } from "./icons";

const ICONS: Record<
  StoreItemType,
  (p: { size?: number; className?: string }) => React.JSX.Element
> = {
  identity: IdCardIcon,
  knowledge: BookOpenIcon,
  plugin: PuzzleIcon,
  bundle: PackageIcon,
};

const BADGE: Record<StoreState, string> = {
  installed:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  update:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  available:
    "bg-brand-100 text-brand-800 dark:bg-brand-950/60 dark:text-brand-300",
  soon: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`;

function StateBadge({ state }: { state: StoreState }): React.JSX.Element {
  return (
    <span
      className={
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium " + BADGE[state]
      }
      data-testid="store-item-state"
      data-state={state}
    >
      {t(`store.state.${state}` as Key)}
    </span>
  );
}

/** Nome di una lingua scritto in quella lingua: «Italiano», «Français». */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code.toUpperCase();
  }
}

const isInstalled = (item: StoreEntry): boolean =>
  item.state === "installed" || item.state === "update";

/**
 * Una scheda dello store: una voce, o le varianti della stessa voce in lingue diverse (si sceglie quale
 * installare). Titolo e descrizione, requisiti, stato e azione sono quelli della variante scelta.
 */
function StoreCard({
  group,
  all,
  busyId,
  searching,
  onInstall,
  onRemove,
}: {
  group: StoreGroup;
  all: Map<string, StoreEntry>;
  busyId: string | null;
  searching: boolean;
  onInstall(id: string): void;
  onRemove(id: string): void;
}): React.JSX.Element {
  const locale = getLocale();
  const [chosen, setChosen] = useState(group.preferred.id);
  const item = group.variants.find((v) => v.id === chosen) ?? group.preferred;
  const busy = busyId === item.id;
  const languages = group.variants.filter((v) => v.language);
  // La ricerca ha trovato il testo in un'altra variante: lo si dice, così si capisce perché la scheda è qui.
  const elsewhere =
    searching && !group.matched.some((m) => m.id === item.id)
      ? group.matched[0]
      : null;
  // Rimuovere chiede conferma, come in Impostazioni → Conoscenza: dice quante conversazioni la collegano.
  const [confirming, setConfirming] = useState(false);
  const linkedIn = useKnowledge(
    (s) => s.bases.find((b) => b.packageId === item.id)?.conversations ?? 0,
  );
  const Icon = ICONS[item.type];
  const related = (ids: string[] | undefined): StoreEntry[] =>
    (ids ?? []).map((id) => all.get(id)).filter((x): x is StoreEntry => !!x);
  const contains = related(item.contains);
  const requires = related(item.requires);
  const details = [
    item.author,
    `v${item.version.split("+")[0]}`,
    item.size ? fmtSize(item.size) : null,
    item.price ? `${item.price.toFixed(2)} €` : t("store.free"),
  ].filter(Boolean);
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
      data-testid="store-item"
      data-id={item.id}
      data-group={group.key}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3
              className="min-w-0 break-words font-semibold"
              data-testid="store-item-name"
            >
              {localize(item.name, locale)}
            </h3>
            <StateBadge state={item.state} />
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {localize(item.summary, locale)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">{details.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {(item.state === "available" || item.state === "update") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onInstall(item.id)}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="store-item-install"
            >
              {busy
                ? t("store.working")
                : t(item.state === "update" ? "store.update" : "store.install")}
            </button>
          )}
          {item.removable && !confirming && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-red-700 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
              data-testid="store-item-remove"
            >
              {t("store.remove")}
            </button>
          )}
        </div>
      </div>

      {confirming && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-2.5 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          data-testid="store-item-confirm"
        >
          <span className="min-w-0 flex-1">
            {t("store.remove.confirm", { name: localize(item.name, locale) })}{" "}
            {item.type === "identity"
              ? t("store.role.remove.hint")
              : linkedIn > 0
                ? tn("knowledge.library.delete.confirm", linkedIn)
                : t("knowledge.library.delete.confirmNone")}
          </span>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
            onClick={() => {
              setConfirming(false);
              onRemove(item.id);
            }}
            data-testid="store-item-remove-confirm"
          >
            {t("store.remove")}
          </button>
          <button
            type="button"
            className="rounded-lg px-2.5 py-1 hover:bg-red-100 dark:hover:bg-red-900/40"
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {languages.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300"
          role="group"
          aria-label={t("store.availableIn")}
          data-testid="store-item-languages"
        >
          <span>{t("store.availableIn")}</span>
          {languages.length === 1 ? (
            // Una sola lingua: non c'è nulla da scegliere.
            <span
              className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
              data-testid="store-item-language"
              data-language={languages[0].language}
            >
              {languageName(languages[0].language!)}
            </span>
          ) : (
            languages.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={v.id === item.id}
              onClick={() => {
                setConfirming(false);
                setChosen(v.id);
              }}
              data-testid="store-item-language"
              data-language={v.language}
              data-installed={isInstalled(v)}
              className={
                "rounded-full border px-2.5 py-0.5 transition-colors disabled:cursor-default " +
                (v.id === item.id
                  ? "border-brand-600 bg-brand-50 font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800")
              }
            >
              {languageName(v.language!)}
              {isInstalled(v) && (
                <span className="ml-1 text-emerald-700 dark:text-emerald-400" aria-label={t("store.state.installed")}>
                  ✓
                </span>
              )}
            </button>
            ))
          )}
        </div>
      )}

      {elsewhere && (
        <p className="text-xs leading-snug text-zinc-600 dark:text-zinc-300" data-testid="store-item-found">
          {t("store.foundIn", {
            language: elsewhere.language ? languageName(elsewhere.language) : "",
            name: localize(elsewhere.name, locale),
          })}
        </p>
      )}

      {(contains.length > 0 || requires.length > 0) && (
        <div className="flex flex-col gap-1 rounded-lg bg-zinc-50 px-2.5 py-2 text-sm dark:bg-zinc-900/60">
          {[
            { label: t("store.contains"), list: contains },
            { label: t("store.requires"), list: requires },
          ].map(
            ({ label, list }) =>
              list.length > 0 && (
                <div key={label}>
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {label}
                  </span>
                  <ul className="mt-1 flex flex-col gap-1">
                    {list.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center gap-2"
                        data-testid="store-item-part"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {localize(c.name, locale)}{" "}
                          <span className="text-xs text-zinc-500">
                            · {t(`store.category.${c.type}` as Key)}
                          </span>
                        </span>
                        <StateBadge state={c.state} />
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </div>
      )}

      <p className="text-xs leading-snug text-zinc-500">
        {item.type === "knowledge" &&
          (item.embedding
            ? t("store.vectors", { model: item.embedding.model })
            : t("store.textOnly"))}
        {item.type === "identity" &&
          item.model &&
          t(
            item.model.required
              ? "store.model.required"
              : "store.model.recommended",
            { model: item.model.name },
          ) + "."}
        {item.builtin &&
          ` ${t(item.type === "identity" ? "store.builtin.role" : "store.builtin")}.`}
        {item.state === "update" &&
          item.installedVersion &&
          ` ${t("store.installedVersion", { version: item.installedVersion.split("+")[0] })}.`}
        {item.type === "knowledge" &&
          item.state !== "available" &&
          item.state !== "soon" &&
          ` ${t("store.installed.hint")}`}
        {item.type === "identity" &&
          isInstalled(item) &&
          ` ${t("store.role.hint")}`}
        {item.type === "plugin" && ` ${t("store.soon.hint")}`}
      </p>
    </li>
  );
}

/** Lo store: una finestra sopra la chat, divisa in categorie. Mostra il catalogo e ciò che è già installato. */
export function StoreDialog({
  onClose,
  initialTab = "knowledge",
}: {
  onClose(): void;
  /** Categoria aperta all'arrivo: «Altri ruoli nello Store…» porta ai ruoli. */
  initialTab?: StoreItemType;
}): React.JSX.Element {
  const [view, setView] = useState<StoreView | null>(null);
  const [tab, setTab] = useState<StoreItemType>(initialTab);
  const [query, setQuery] = useState("");
  /** Filtro per lingua del contenuto; null = tutte. */
  const [language, setLanguage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const locale = getLocale();

  const load = async (): Promise<void> => {
    setError(null);
    const res = await window.api.store.catalog();
    if (res.ok) setView(res.data);
    else setError(res.error);
  };
  useEffect(() => {
    dialog.current?.showModal();
    void load();
    void useKnowledge.getState().loadBases();
  }, []);

  /** Installa o rimuove, poi allinea libreria e conversazioni aperte. */
  const act = async (
    id: string,
    action: "install" | "remove",
  ): Promise<void> => {
    setBusy(id);
    setError(null);
    const res = await window.api.store[action](id);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setView(res.data);
    const knowledge = useKnowledge.getState();
    void knowledge.loadBases();
    for (const key of Object.keys(knowledge.status)) void knowledge.load(key);
    // Un ruolo installato o rimosso: l'elenco di «Parla con un…» si rilegge.
    void useRoles.getState().refresh();
  };

  const all = useMemo(
    () => new Map((view?.items ?? []).map((i) => [i.id, i])),
    [view],
  );
  const needle = query.trim();
  const items = view?.items ?? [];
  const languages = storeLanguages(items, tab);
  // Il filtro vale per la categoria aperta: una lingua che lì non c'è non filtra.
  const activeLanguage = language && languages.includes(language) ? language : null;
  const shown = storeGroups(items, { type: tab, query: needle, language: activeLanguage, locale });
  const count = (type: StoreItemType): number =>
    storeGroups(items, { type, locale }).length;

  return (
    <dialog
      ref={dialog}
      aria-label={t("store.title")}
      data-testid="store-dialog"
      onClose={onClose}
      className="m-auto h-[88vh] max-h-[88vh] w-[90vw] max-w-[90vw] overflow-hidden rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 border-b border-zinc-200 px-5 pt-4 dark:border-zinc-800">
          <h2 className="text-lg font-semibold">{t("store.title")}</h2>
          <div
            role="tablist"
            aria-label={t("store.categories")}
            className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto"
          >
            {STORE_CATEGORIES.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                data-testid={`store-tab-${id}`}
                className={
                  "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm " +
                  (tab === id
                    ? "border-brand-600 font-medium text-brand-700 dark:text-brand-300"
                    : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
                }
              >
                {t(`store.category.${id}` as Key)}
                {view && (
                  <span className="ml-1 text-xs text-zinc-400">
                    {count(id)}
                  </span>
                )}
              </button>
            ))}
          </div>
          <DialogClose onClose={onClose} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              aria-label={t("store.search")}
              placeholder={t("store.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-[12rem] flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              data-testid="store-search"
            />
            {languages.length > 0 && (
              <div
                role="radiogroup"
                aria-label={t("store.language.filter")}
                className="flex shrink-0 overflow-hidden rounded-lg border border-zinc-300 text-sm dark:border-zinc-700"
                data-testid="store-language-filter"
              >
                {[null, ...languages].map((code, i) => (
                  <button
                    key={code ?? "all"}
                    type="button"
                    role="radio"
                    aria-checked={activeLanguage === code}
                    onClick={() => setLanguage(code)}
                    data-language={code ?? "all"}
                    className={
                      "px-3 py-1.5 transition-colors " +
                      (i > 0 ? "border-l border-zinc-300 dark:border-zinc-700 " : "") +
                      (activeLanguage === code
                        ? "bg-brand-600 font-medium text-white"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800")
                    }
                  >
                    {code ? languageName(code) : t("store.language.all")}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(error ?? view?.error) && (
            <p
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              data-testid="store-error"
            >
              {error ?? view?.error}
            </p>
          )}

          {!view ? (
            !error && (
              <p className="py-6 text-center text-sm text-zinc-500">
                {t("store.loading")}
              </p>
            )
          ) : shown.length === 0 ? (
            <p
              className="py-6 text-center text-sm text-zinc-500"
              data-testid="store-empty"
            >
              {needle
                ? t("store.noResults", { query: needle })
                : t("store.empty")}
            </p>
          ) : (
            <ul
              className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] items-start gap-3"
              data-testid="store-items"
            >
              {shown.map((group) => (
                <StoreCard
                  // La variante preselezionata cambia con il filtro per lingua: la scheda riparte da lì.
                  key={`${group.key}:${group.preferred.id}`}
                  group={group}
                  all={all}
                  busyId={busy}
                  searching={needle !== ""}
                  onInstall={(id) => void act(id, "install")}
                  onRemove={(id) => void act(id, "remove")}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-zinc-200 px-5 py-2 text-xs text-zinc-500 dark:border-zinc-800">
          <span className="min-w-0 flex-1 truncate" data-testid="store-source">
            {view &&
              (view.source === "remote"
                ? t("store.source.remote", { url: view.url })
                : t("store.source.local"))}
            {view?.updatedAt
              ? ` · ${t("store.updatedAt", { date: view.updatedAt })}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            data-testid="store-refresh"
          >
            {t("store.refresh")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
