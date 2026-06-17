import { ref, computed, toRaw, onMounted, watch, nextTick }  from 'vue'
import { useSwitcherConfig }                                 from './useSwitcherConfig'

export function useSwitcherPersistence(scope) {
    const cfg = useSwitcherConfig(scope)

    /**
     * Grab a deep clone of the *initial* config (after everything is rendered).
     */
    const savedSnapshot = ref({})

    onMounted( async () => {
        await nextTick()
        savedSnapshot.value = structuredClone( toRaw( cfg ) )
    })

    /**
     * Are there any unsaved changes?
     */
    const isDirty = computed(() => {
        return JSON.stringify(cfg) !== JSON.stringify(savedSnapshot.value)
    })

    const saving   = ref(false)
    const justSaved= ref(false);
    const errorMsg = ref('')

    function handleBeforeUnload (e) {
        // only run when dirty
        if (!isDirty.value) return
        e.preventDefault()      // Chrome
        e.returnValue = ''      // legacy
    }

    /* attach / detach based on isDirty */
    watch(isDirty, (dirty) => {
        if (dirty)
            window.addEventListener('beforeunload', handleBeforeUnload)
        else
            window.removeEventListener('beforeunload', handleBeforeUnload)

    }, { immediate: true })

    async function save() {
        saving.value = true
        errorMsg.value = ''

        try {
            const body = new FormData()
            body.append('action', 'trp_language_switcher_save')
            body.append('nonce',  tpLangSwitcherData.nonce)
            body.append('scope',  scope)
            body.append('config', JSON.stringify(cfg))

            const res = await fetch(ajaxurl, {
                method: 'POST',
                credentials: 'same-origin',
                body
            })

            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            // Update our snapshot
            savedSnapshot.value = structuredClone(toRaw(cfg))

            justSaved.value = true
            setTimeout(() => { justSaved.value = false }, 2000)
        } catch (err) {
            errorMsg.value = err.message || 'Save failed'
        } finally {
            saving.value = false
        }
    }

    function revert() {
        Object.assign(cfg, structuredClone(toRaw(savedSnapshot.value)))
    }

    return { save, revert, saving, justSaved, errorMsg, isDirty }
}
