import type { PickerSession } from './drive';

// The thin adapter around Google Picker (#290 slice 3, spec decision 2). It is
// Google's widget, loaded from apis.google.com, so it is not unit-tested; the
// import dialog takes it as a prop and its tests stub it. The /admin CSP allows
// exactly this script and Picker's frames (src/middleware.ts).

interface GooglePickerNamespace {
  ViewId: { DOCS: unknown };
  DocsViewMode: { LIST: unknown };
  Feature: { MULTISELECT_ENABLED: unknown; SUPPORT_DRIVES: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
  DocsView: new (viewId: unknown) => {
    setIncludeFolders(v: boolean): unknown;
    setSelectFolderEnabled(v: boolean): unknown;
    setMode(mode: unknown): unknown;
  };
  PickerBuilder: new () => PickerBuilder;
}

interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setMaxItems(n: number): PickerBuilder;
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}

declare global {
  interface Window {
    gapi?: { load(name: string, cb: () => void): void };
    google?: { picker?: GooglePickerNamespace };
  }
}

let loading: Promise<GooglePickerNamespace> | null = null;

function loadPicker(): Promise<GooglePickerNamespace> {
  loading ??= new Promise((resolve, reject) => {
    const ready = () =>
      window.gapi!.load('picker', () => {
        if (window.google?.picker) resolve(window.google.picker);
        else reject(new Error('Google Picker did not load.'));
      });
    if (window.gapi) return ready();
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = ready;
    script.onerror = () => {
      loading = null;
      reject(new Error('Google Picker could not be loaded.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Open Google Picker on the association's Drive and resolve to the picked file
 * IDs, or an empty list when the board admin cancels.
 */
export async function pickDriveFiles(
  session: PickerSession,
  maxItems: number,
): Promise<string[]> {
  const picker = await loadPicker();
  const view = new picker.DocsView(picker.ViewId.DOCS);
  view.setIncludeFolders(false);
  view.setSelectFolderEnabled(false);
  view.setMode(picker.DocsViewMode.LIST);
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(session.accessToken)
      .setDeveloperKey(session.developerKey)
      .setAppId(session.appId)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setMaxItems(maxItems)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const docs = (data[picker.Response.DOCUMENTS] ?? []) as Record<
            string,
            unknown
          >[];
          resolve(
            docs
              .map((d) => d[picker.Document.ID])
              .filter((id): id is string => typeof id === 'string'),
          );
        } else if (action === picker.Action.CANCEL) resolve([]);
      })
      .build()
      .setVisible(true);
  });
}
