<script setup>
import { ref }    from 'vue'
import { useSwitcherConfig } from "../composables/useSwitcherConfig"
import PresetPreviewLanguageSwitcher from './PresetPreviewLanguageSwitcher.vue'
import { __, sprintf }               from "@wordpress/i18n"

const props = defineProps({
    scope: {
      type: String,
      required: true,
      validator: v => ['floater','shortcode','menu'].includes(v)
    }
})

const cfg = useSwitcherConfig(props.scope)

/** Localized UI text */
const T = {
    presetDefault: __('Default', 'translatepress-multilingual'),
    presetDark: __('Dark', 'translatepress-multilingual'),
    presetBorder: __('Border', 'translatepress-multilingual'),
    presetTransparent: __('Transparent', 'translatepress-multilingual'),
    confirmTitleHtml: __('Are you sure you want to apply the <strong>%s</strong> preset?', 'translatepress-multilingual'),
    confirmOverwrite: __('It will override your current settings.', 'translatepress-multilingual'),
    applyPreset: __('Apply preset', 'translatepress-multilingual'),
    cancel: __('Cancel', 'translatepress-multilingual'),
    applyPresetWithName: __('Apply %s preset', 'translatepress-multilingual'),
}

const presets = [
    {
        id: 'default',
        name: T.presetDefault,
        settings: {
            bgColor:        '#ffffff',
            bgHoverColor:   '#0000000D',
            textColor:      '#143852',
            textHoverColor: '#1D2327',
            borderColor:    '#1438521A'
        }
    },
    {
        id: 'dark',
        name: T.presetDark,
        settings: {
            bgColor:        '#000000',
            bgHoverColor:   '#444444',
            textColor:      '#ffffff',
            textHoverColor: '#eeeeee',
            borderColor:    'transparent'
        }
    },
    {
        id: 'border',
        name: T.presetBorder,
        settings: {
            bgColor:        '#FFFFFF',
            bgHoverColor:   '#000000',
            textColor:      '#143852',
            textHoverColor: '#ffffff',
            borderColor:    '#143852'
        }
    },
    {
        id: 'transparent',
        name: T.presetTransparent,
        settings: {
            bgColor:        '#FFFFFFB2',
            bgHoverColor:   '#0000000D',
            textColor:      '#000000',
            textHoverColor: '#000000',
            borderColor:    'transparent'
        }
    },
]

// helper: map settings → CSS variables on the card
function cssVars(s) {
    return {
        '--bg':           s.bgColor,
        '--bg-hover':     s.bgHoverColor,
        '--text':         s.textColor,
        '--text-hover':   s.textHoverColor,
        '--border-color': s.borderColor
    }
}

const confirmPreset = ref(null)

function requestApply(preset) {
    confirmPreset.value = preset
}

function cancelApply() {
    confirmPreset.value = null
}

function applyPreset() {
    if (!confirmPreset.value) return

    Object.entries(confirmPreset.value.settings).forEach(([key, val]) => {
        cfg[key] = val
    })

    confirmPreset.value = null
}
</script>

<template>
    <div class="trp-preset-applier">
        <div
            v-for="preset in presets"
            :key="preset.id"
            class="trp-preset-card"
            :style="cssVars(preset.settings)"
        >
            <div class="trp-preview-rect"
                 :style="{ background: preset.id === 'transparent' ? 'linear-gradient(145.41deg, #2271B1 20.41%, #D3B4DA 96.59%)' : '#DBDBDB' }"
            >
                <PresetPreviewLanguageSwitcher :scope="scope" />
                <div
                    v-if="confirmPreset && confirmPreset.id === preset.id"
                    class="trp-confirmation-dialog"
                >
                    <!-- translators: %s is the preset name -->
                    <p class="trp-primary-text" v-html="sprintf(T.confirmTitleHtml, preset.name)"></p>
                    <p class="trp-primary-text trp-confirmation-overwrite-warning">{{ T.confirmOverwrite }}</p>
                    <div class="trp-dialog-actions">
                        <button class="trp-confirm-button" @click="applyPreset">{{ T.applyPreset }}</button>
                        <span class="trp-description-text trp-cancel-button" @click="cancelApply">{{ T.cancel }}</span>
                    </div>
                </div>
            </div>

            <button class="trp-apply-btn" @click="requestApply(preset)">
                <!-- translators: %s is the preset name -->
                {{ sprintf(T.applyPresetWithName, preset.name) }}
            </button>
        </div>
    </div>
</template>

<style scoped>
/* Add Fallback to vars */
:root, .trp-preset-applier {
    --bg:           #ffffff;
    --bg-hover:     #ffffff;
    --text:         #000000;
    --text-hover:   #000000;
    --border-color: #1438521A;
    --radius:       0px;
}

.trp-preset-applier {
    display: grid;
    gap: 16px;
}

.trp-preset-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

/* ≥ 500 px -> 2 columns */
@media (min-width: 500px) {
    .trp-preset-applier {
        grid-template-columns: repeat(2, 1fr);
    }
}

.trp-confirm-button {
    cursor: pointer;
    border-radius: var(--trp-settings-radius-medium);
    color: #ffffff;
    background: var(--trp-settings-accent-color);
    border: 1px solid var(--trp-settings-accent-color);
    padding: 5px 10px;
}


.trp-confirm-button:hover {
    background: transparent;
    color: var(--trp-settings-accent-color);
}

.trp-preview-rect {
    width: 100%;
    height: 145px;
    background: #DBDBDB;
    padding: 16px 0;
    border-radius: var(--trp-settings-radius-high);
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
}

.trp-apply-btn {
    all: unset;
    color: var(--trp-settings-accent-color);
    font-size: var(--trp-settings-primary-font-size);
    font-weight: 500;
    cursor: pointer;
}

.trp-apply-btn:hover {
    opacity: 0.8;
}

.trp-confirmation-dialog {
    background: #fff;
    padding: 16px;
    border-radius: 8px;
    border: 1px solid;
    text-align: center;
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
}

.trp-dialog-actions {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    justify-content: center;
    align-items: center;
}

.trp-confirmation-overwrite-warning {
    color: #C94F2D;
}

.trp-cancel-button {
    cursor: pointer;
}
</style>
