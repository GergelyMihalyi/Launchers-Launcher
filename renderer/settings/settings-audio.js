// Settings → Audio output subview. Load order: after settings.js.

let audioSinks = [];
let audioFocusIndex = 0;
let audioButtonStates = {};

async function openAudioSinkView() {
    // The X that entered here from the menu may still be held at the moment of entry - our own edge watching is set to that, otherwise it would
    // select again right after the list loads.
    audioButtonStates = { cross: true };
    setSubviewFrame({ title: tr('sv.audioTitle'), hint: 'hint.select', skeleton: true });
    const res = await window.launcher.listAudioSinks();
    if (settingsView !== 'audio-sink') return; // left the subview meanwhile
    if (!res.ok) { renderSubviewError(tr('sv.sinksFailed')); return; }
    audioSinks = res.items;
    audioFocusIndex = Math.max(0, audioSinks.findIndex((s) => s.isDefault));
    renderAudioList();
}

function renderAudioList() {
    const listEl = $('settingsContent');
    if (!audioSinks.length) {
        listEl.innerHTML = emptyState(tr('sv.noSinks'));
        return;
    }
    listEl.innerHTML = audioSinks.map((sink, i) => `
        <div class="settings-item ${i === audioFocusIndex ? 'focused' : ''}">
            ${esc(sink.description)}${sink.isDefault ? ` ${currentTag(tr('sv.active'))}` : ''}
        </div>
    `).join('');
    scrollSettingsFocusIntoView();
}

function selectAudioSink(gp) {
    const sink = audioSinks[audioFocusIndex];
    if (!sink) return;
    window.launcher.setAudioSink(sink.name);
    closeSettings(gp);
}

// Subview ○/PS = back to the menu (not close); `backToSettingsMenu(gp)` syncs the menu's edge state with the still held button.
function handleAudioSinkInput(gp) {
    navList(gp, audioButtonStates, {
        count: audioSinks.length,
        move: (d, repeated) => {
            audioFocusIndex = stepIndex(audioFocusIndex, d, audioSinks.length, repeated);
            renderAudioList();
        },
        onSelect: () => selectAudioSink(gp),
        onBack: () => backToSettingsMenu(gp),
    });
}

SETTINGS_VIEWS['audio-sink'] = { open: openAudioSinkView, handle: handleAudioSinkInput };
