<?php

if ( !defined( 'ABSPATH' ) )
    exit();

/**
 * Class TRP_Glossary
 *
 * Provides glossary substitutions during machine translation by exposing
 * filter callbacks for `trp_exclude_words_from_automatic_translation` and
 * `trp_replace_placeholders_with`.
 *
 * Terms are read from the `trp_glossary` option managed by
 * TRP_Glossary_Queries. Each glossary term (a default-language string) is
 * protected from automatic translation; for target languages where the user
 * supplied a translation the placeholder is restored with that translation,
 * otherwise the original term is kept. Matching against page strings is
 * case-insensitive.
 */
class TRP_Glossary {

    /**
     * Settings array passed in at construction (full trp settings, like other tabs).
     *
     * @var array
     */
    private $settings;

    /**
     * Cached glossary terms loaded from the `trp_glossary` option.
     * Structure: array( default_term => array( target_locale => translation ) ).
     *
     * @var array|null
     */
    protected $terms = null;

    /**
     * Per-target-language replacement maps, keyed by target locale.
     * Each map is: lowercase( default_term ) => translation.
     *
     * @var array
     */
    protected $replacement_cache = array();

    public function __construct( $settings = array() ) {
        $this->settings = $settings;

        add_filter( 'trp_settings_active_tab', array( $this, 'filter_active_tab' ) );
    }

    /**
     * Keep the Automatic Translation nav tab highlighted while on the glossary page.
     *
     * @param string $active_tab
     * @return string
     */
    public function filter_active_tab( $active_tab ) {
        if ( $active_tab === 'trp_machine_translation_glossary' || $active_tab === 'trp_glossary_replace' ) {
            return 'trp_machine_translation';
        }
        return $active_tab;
    }

    /**
     * Add submenu page for the glossary settings.
     *
     * Hooked to admin_menu.
     */
    public function add_submenu_page() {
        add_submenu_page(
            'TRPHidden',
            'TranslatePress Glossary',
            'TRPHidden',
            // Same capability as the glossary actions and the replace page, so admins and
            // TranslatePress translator accounts can access the UI they're allowed to use.
            apply_filters( 'trp_translating_capability', 'manage_options' ),
            'trp_machine_translation_glossary',
            array( $this, 'glossary_page_content' )
        );
    }

    /**
     * Register settings option.
     *
     * Hooked to admin_init.
     */
    public function register_setting() {
        register_setting( 'trp_glossary_settings', 'trp_glossary_settings', array( $this, 'sanitize_settings' ) );
    }

    /**
     * Sanitize submitted glossary settings.
     *
     * @param mixed $submitted_settings
     * @return array
     */
    public function sanitize_settings( $submitted_settings ) {
        $settings = is_array( $submitted_settings ) ? $submitted_settings : array();

        return apply_filters( 'trp_extra_sanitize_glossary_settings', $settings, $submitted_settings );
    }

    /**
     * Output admin notices after saving glossary settings.
     *
     * Hooked to admin_notices.
     */
    public function admin_notices() {
        if ( isset( $_GET['page'] ) && $_GET['page'] === 'trp_machine_translation_glossary' ) {
            settings_errors( 'trp_glossary_settings' );
        }
    }

    /**
     * Render the glossary settings page.
     */
    public function glossary_page_content() {
        require_once TRP_PLUGIN_DIR . 'partials/glossary-settings-page.php';
    }

    /**
     * Lazy-load the glossary terms from the `trp_glossary` option.
     *
     * @return array Structure: array( default_term => array( target_locale => translation ) ).
     */
    protected function get_terms() {
        if ( $this->terms === null ) {
            $terms       = get_option( TRP_Glossary_Queries::OPTION_NAME, array() );
            $this->terms = is_array( $terms ) ? $terms : array();
        }

        return $this->terms;
    }

    /**
     * The glossary only drives automatic translation for the TranslatePress AI
     * engine (`mtapi`). Other engines (DeepL, Google Translate) manage glossaries
     * in their own provider dashboards, so we don't interfere with their output.
     *
     * @return bool
     */
    public function is_tp_ai_active() {
        $mt_settings = get_option( 'trp_machine_translation_settings', array() );
        return is_array( $mt_settings )
            && isset( $mt_settings['translation-engine'] )
            && $mt_settings['translation-engine'] === 'mtapi';
    }

    /**
     * Build a case-insensitive, whole-word regex for a literal term.
     *
     * Uses Unicode-aware lookarounds (not \b) so a match must not be adjacent to
     * a letter/number/underscore on either side — accented letters are handled
     * correctly. This makes "care" match in "Handle with care." but not in
     * "caregiver", and "grated cheese" not match inside "ungrated cheese".
     *
     * @param string $term
     * @return string PCRE pattern.
     */
    public function whole_word_pattern( $term ) {
        return '/(?<![\p{L}\p{N}_])' . preg_quote( $term, '/' ) . '(?![\p{L}\p{N}_])/iu';
    }

    /**
     * Whether a language separates words (so whole-word matching makes sense).
     *
     * Scripts like Chinese, Japanese and Thai run words together with no spaces,
     * so the lookaround word boundaries never match there — those languages must
     * fall back to plain substring matching.
     *
     * @param string $language_code Full locale (e.g. zh_CN) or language prefix.
     * @return bool
     */
    public function uses_word_boundaries( $language_code ) {
        $no_boundary = apply_filters(
            'trp_glossary_languages_without_word_boundaries',
            array( 'zh', 'ja', 'th', 'lo', 'km', 'my', 'bo' )
        );
        $prefix = strtolower( (string) strtok( (string) $language_code, '_' ) );
        return ! in_array( $prefix, $no_boundary, true );
    }

    /**
     * Regex to match a term, honoring word boundaries for spaced languages and
     * falling back to a substring match for languages that don't use spaces.
     *
     * @param string $term
     * @param string $language_code Language the matched text belongs to.
     * @return string PCRE pattern.
     */
    public function term_match_pattern( $term, $language_code = '' ) {
        if ( $language_code !== '' && ! $this->uses_word_boundaries( $language_code ) ) {
            return '/' . preg_quote( $term, '/' ) . '/iu';
        }
        return $this->whole_word_pattern( $term );
    }

    /**
     * Build (and cache) the lowercase-term => translation map for a target language.
     * Only terms that have a non-empty translation for that language are included.
     *
     * @param string $target_language_code Full locale, e.g. de_DE.
     * @return array
     */
    protected function get_target_replacements( $target_language_code ) {
        if ( !isset( $this->replacement_cache[ $target_language_code ] ) ) {
            $map = array();

            foreach ( $this->get_terms() as $term => $translations ) {
                if ( $term === '' || !is_array( $translations ) ) {
                    continue;
                }
                if ( isset( $translations[ $target_language_code ] ) && $translations[ $target_language_code ] !== '' ) {
                    $map[ strtolower( $term ) ] = $translations[ $target_language_code ];
                }
            }

            $this->replacement_cache[ $target_language_code ] = $map;
        }

        return $this->replacement_cache[ $target_language_code ];
    }

    /**
     * Add every case-variant of each glossary term found in the strings to the
     * exclude-words array, protecting them from automatic translation. Each
     * variant gets its own placeholder slot, so a sentence containing both
     * "World" and "world" produces two placeholders.
     *
     * @param array  $exclude_words        Existing exclusions (e.g. %s, %d).
     * @param string $imploded_strings     All strings in the current batch, joined.
     * @param string $target_language_code Target language (full locale). Terms without a
     *                                     translation for it are left unprotected.
     * @return array
     */
    public function add_excluded_words( $exclude_words, $imploded_strings = '', $target_language_code = '' ) {
        if ( !is_array( $exclude_words ) ) {
            $exclude_words = array();
        }

        // Glossary only applies to the TranslatePress AI engine.
        if ( ! $this->is_tp_ai_active() ) {
            return $exclude_words;
        }

        if ( !is_string( $imploded_strings ) || $imploded_strings === '' ) {
            return $exclude_words;
        }

        // Source strings are in the default language; use its boundary rules.
        $default_language = isset( $this->settings['default-language'] ) ? $this->settings['default-language'] : '';

        foreach ( $this->get_terms() as $term => $translations ) {
            if ( $term === '' || ! is_array( $translations ) ) {
                continue;
            }
            // Only protect the term for target languages where the user supplied a
            // translation. Without one, leave it unprotected so the MT engine
            // translates it normally instead of keeping the original word.
            if ( $target_language_code !== '' && ( ! isset( $translations[ $target_language_code ] ) || $translations[ $target_language_code ] === '' ) ) {
                continue;
            }
            // Only protect the term where it appears as a whole word (for spaced
            // languages), so a compound like "caregiver" is still translated normally.
            if ( preg_match_all( $this->term_match_pattern( $term, $default_language ), $imploded_strings, $matches ) ) {
                foreach ( array_unique( $matches[0] ) as $variant ) {
                    if ( !in_array( $variant, $exclude_words, true ) ) {
                        $exclude_words[] = $variant;
                    }
                }
            }
        }

        return $exclude_words;
    }

    /**
     * Swap protected glossary terms in the placeholder-restoration array with the
     * translation configured for the current target language. Non-glossary items
     * (e.g. %s, %d) and terms without a translation for this language pass through
     * unchanged, so they are restored to their original text.
     *
     * The array length is preserved (values are swapped in place) so it stays
     * aligned with the placeholder tokens.
     *
     * @param array  $replacements         Default = the exclude-words array.
     * @param array  $exclude_words        Original exclude-words array.
     * @param array  $placeholders         Placeholder tokens (positional).
     * @param string $machine_string       MT output before restoration.
     * @param string $original_string      Pre-translation original.
     * @param string $target_language_code Target language code (full locale).
     * @param string $source_language_code Source language code (full locale).
     * @return array
     */
    public function apply_replacements( $replacements, $exclude_words, $placeholders, $machine_string, $original_string, $target_language_code, $source_language_code ) {
        if ( !is_array( $replacements ) ) {
            return $replacements;
        }

        // Glossary only applies to the TranslatePress AI engine.
        if ( ! $this->is_tp_ai_active() ) {
            return $replacements;
        }

        // Glossary terms are default-language strings; only apply when translating from the default language.
        $default_language = isset( $this->settings['default-language'] ) ? $this->settings['default-language'] : '';
        if ( $default_language !== '' && $source_language_code !== null && $source_language_code !== $default_language ) {
            return $replacements;
        }

        $map = $this->get_target_replacements( $target_language_code );
        if ( empty( $map ) ) {
            return $replacements;
        }

        foreach ( $replacements as $index => $value ) {
            if ( !is_string( $value ) ) {
                continue;
            }
            $lookup = strtolower( $value );
            // Only substitute when the term is a whole word in THIS string (for spaced
            // languages). This keeps a shared placeholder (e.g. for "care") from replacing
            // inside "caregiver" when both appear in the same translation batch. The source
            // string is in the default language, so use its boundary rules.
            if ( isset( $map[ $lookup ] ) && preg_match( $this->term_match_pattern( $value, $default_language ), (string) $original_string ) ) {
                $replacements[ $index ] = $this->match_case( $value, $map[ $lookup ] );
            }
        }

        return $replacements;
    }

    /**
     * Copy the capitalization pattern of the matched source term onto the
     * translation. Deterministic and intentionally simple:
     *   - ALL CAPS   (WORLD) -> uppercase the translation
     *   - all lower  (world) -> lowercase the translation
     *   - Capitalized(World) -> upper-case the first letter of the translation
     *   - anything mixed (iPhone, Hello World) -> leave the translation as configured
     *
     * @param string $source      The exact source term variant matched in the text.
     * @param string $translation The configured translation for the target language.
     * @return string
     */
    public function match_case( $source, $translation ) {
        if ( $translation === '' ) {
            return $translation;
        }

        $upper = mb_strtoupper( $source, 'UTF-8' );
        $lower = mb_strtolower( $source, 'UTF-8' );

        if ( $source === $upper && $upper !== $lower ) {          // ALL CAPS (has at least one cased letter)
            return mb_strtoupper( $translation, 'UTF-8' );
        }
        if ( $source === $lower ) {                               // all lower (or no cased letters)
            return mb_strtolower( $translation, 'UTF-8' );
        }
        if ( $this->mb_ucfirst( $lower ) === $source ) {          // Capitalized first letter only
            return $this->mb_ucfirst( $translation );
        }

        return $translation;                                      // mixed casing -> verbatim
    }

    /**
     * Multibyte-safe ucfirst().
     *
     * @param string $string
     * @return string
     */
    public function mb_ucfirst( $string ) {
        if ( $string === '' ) {
            return $string;
        }
        $first = mb_substr( $string, 0, 1, 'UTF-8' );
        return mb_strtoupper( $first, 'UTF-8' ) . mb_substr( $string, 1, null, 'UTF-8' );
    }
}
