// Settings → Games → "Cover download": network download of missing covers on/off (`coverDownload` key, default ON). Affects the quick-launch
// bar and favorite covers of RetroArch/Ryujinx/PCSX2/Dolphin/DuckStation (the Cemu/RPCS3/PPSSPP/melonDS covers are made locally). OFF: the
// `ensure*Covers` wrappers do not even try; already downloaded ones stay. On the `createToggleSubview` factory (settings-toggle.js).

SETTINGS_VIEWS['cover-download'] = createToggleSubview({
    id: 'cover-download',
    hintKey: 'sv.coverDownloadHint',
    onLabelKey: 'sv.coverDownloadOn',
    offLabelKey: 'sv.coverDownloadOff',
    defaultOn: true,
    get: () => window.launcher.getCoverDownload(),
    set: (v) => window.launcher.setCoverDownload(v),
});
