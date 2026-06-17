<?php


if ( !defined('ABSPATH' ) )
    exit();

/**
 * Class TRP_Gettext_Manager
 *
 * Handles 'gettext' hook, replaces default with translation
 */
class TRP_Process_Gettext {
    protected $settings;
    /** @var TRP_Query */
    protected $trp_query;
    protected $machine_translator;
    protected $trp_languages;
    protected $gettext_manager;
    protected $plural_forms;
    protected $machine_translation_codes;
    protected $skip_gettext_querying;
    /**
     * Per-request, per-domain index of catalog (.po/.mo) entries that carry a real, non-empty
     * translation — keyed by "context\4singular". Built lazily once per domain (see
     * gettext_string_has_catalog_translation) because WP_Translations::entries rebuilds the whole
     * entry list on every access and must not be touched inside the gettext filter loop repeatedly.
     *
     * @var array
     */
    protected $catalog_entry_index = array();

    /**
     * TRP_Gettext_Manager constructor.
     *
     * @param array $settings Settings option.
     */
    public function __construct( $settings, $plural_forms ) {
        $this->settings = $settings;
        $this->plural_forms = $plural_forms;
    }

    /**
     * Whether the currently loaded translation catalog (.po/.mo) for a domain actually contains a
     * real, non-empty translation entry for a string — even one identical to the original.
     *
     * WordPress' gettext filter only hands us the resolved translation, which equals the original
     * both when there is no catalog entry and when the entry's msgstr equals the msgid. Only by
     * inspecting the catalog can we tell the two apart and avoid machine-translating strings that
     * are intentionally localized to the same value (e.g. proper nouns like "Åland Islands").
     *
     * The per-domain entry set is built once per request and cached, because WP_Translations::entries
     * (WP 6.5+) rebuilds the whole list on every access.
     *
     * @param string      $domain          Text domain.
     * @param string      $text            The original (singular) string.
     * @param string      $context         Gettext context ('trp_context' when none).
     * @param string|null $original_plural The plural source string, if any.
     * @return bool
     */
    protected function gettext_string_has_catalog_translation( $domain, $text, $context, $original_plural = null ) {
        if ( ! isset( $this->catalog_entry_index[ $domain ] ) ) {
            $this->catalog_entry_index[ $domain ] = array();

            $translations = get_translations_for_domain( $domain );
            /* Access ->entries directly (not via isset): WP_Translations (WP 6.5+) exposes it through
             * a magic __get without a matching __isset, so isset() would wrongly report it as unset. */
            $entries = $translations ? $translations->entries : null;
            if ( is_array( $entries ) ) {
                foreach ( $entries as $entry ) {
                    if ( ! is_object( $entry ) || ! isset( $entry->singular ) || ! isset( $entry->translations ) ) {
                        continue;
                    }

                    // Only count entries that carry an actual translation (msgstr non-empty).
                    $has_translation = false;
                    foreach ( (array) $entry->translations as $entry_translation ) {
                        if ( $entry_translation !== '' && $entry_translation !== null ) {
                            $has_translation = true;
                            break;
                        }
                    }
                    if ( ! $has_translation ) {
                        continue;
                    }

                    $entry_context = isset( $entry->context ) ? (string) $entry->context : '';
                    $this->catalog_entry_index[ $domain ][ $entry_context . "\4" . $entry->singular ] = true;
                }
            }
        }

        $lookup_context = ( $context && $context !== 'trp_context' ) ? (string) $context : '';

        if ( isset( $this->catalog_entry_index[ $domain ][ $lookup_context . "\4" . $text ] ) ) {
            return true;
        }

        if ( $original_plural && isset( $this->catalog_entry_index[ $domain ][ $lookup_context . "\4" . $original_plural ] ) ) {
            return true;
        }

        return false;
    }


    /**
     * Function that replaces the translations with the ones in the database if they are different, wraps the texts in the html and
     * builds a global for machine translation with the strings that are not translated
     * @param $translation
     * @param $text
     * @param $domain
     * @return string
     */
    public function process_gettext_strings( $translation, $text, $domain, $context = 'trp_context', $number_of_items = null, $original_plural = null ) {
        // if we have nested gettexts strip previous ones, and consider only the outermost
        $text        = TRP_Gettext_Manager::strip_gettext_tags( $text );
        $translation = TRP_Gettext_Manager::strip_gettext_tags( $translation );

        //try here to exclude some strings that do not require translation
        $excluded_gettext_strings = array( '', ' ', '&hellip;', '&nbsp;', '&raquo;' );
        $trim_filter              = " \t\n\r\0\x0B\xA0�.,/`~!@#\$€£%^&*():;-_=+[]{}\\|?/<>1234567890'\"";

        if ( in_array( trim( $text, $trim_filter ), $excluded_gettext_strings ) || empty( $text ) )
            return $translation;

        global $TRP_LANGUAGE;

        if ( ( isset( $_REQUEST['trp-edit-translation'] ) && $_REQUEST['trp-edit-translation'] == 'true' ) || $domain == 'translatepress-multilingual' )
            return $translation;

        /* for our own actions don't do nothing */
        if (isset($_REQUEST['action']) && strpos( sanitize_text_field( $_REQUEST['action'] ), 'trp_') === 0)
            return $translation;

        if( $this->skip_gettext_querying === null ) {
            // apply filters takes time. Only do this once. Parameters $translation, $text, $domain are irrelevant but can't be removed due to backwards compatibility
            // Use trp_skip_gettext_processing hook for not adding wrappings.
            $this->skip_gettext_querying = apply_filters( 'trp_skip_gettext_querying', false, $translation, $text, $domain );
        }

        global $trp_wpdb_prefix, $wpdb;
        // When gettext querying is disabled, create_gettext_translated_global() never runs,
        // so $trp_wpdb_prefix stays unset. In that case we still need to reach the
        // gettext wrapper path so regular string detection can skip this output.
        if ( !$this->skip_gettext_querying && $trp_wpdb_prefix != $wpdb->get_blog_prefix() ){
            return $translation;
        }

        /* get_locale() returns WP Settings Language (WPLANG). It might not be a language in TP so it may not have a TP table. */
        $current_locale = get_locale();
        global $trp_translated_gettext_texts_language;
        if ( !$this->skip_gettext_querying && ( !in_array( $current_locale, $this->settings['translation-languages'] ) || empty( $trp_translated_gettext_texts_language ) || $trp_translated_gettext_texts_language !== $current_locale ) ) {
            return $translation;
        }

        $plural_form = $this->plural_forms->get_plural_form( $number_of_items, $current_locale );

        //set a global so we remember the last string we processed and if it is the same with the current one return a result immediately for performance reasons ( this could happen in loops )
        global $tp_last_gettext_processed;
        if ( isset( $tp_last_gettext_processed[ $context . '::' . $plural_form . '::' . $text . '::' . $domain ] ) )
            return $tp_last_gettext_processed[ $context . '::' . $plural_form . '::' . $text . '::' . $domain ];

        if ( apply_filters( 'trp_skip_gettext_processing', false, $translation, $text, $domain ) )
            return $translation;

        //use a global for is_ajax_on_frontend() so we don't execute it multiple times
        global $tp_gettext_is_ajax_on_frontend;
        if ( !isset( $tp_gettext_is_ajax_on_frontend ) )
            $tp_gettext_is_ajax_on_frontend = TRP_Gettext_Manager::is_ajax_on_frontend();

        if ( !defined( 'DOING_AJAX' ) || $tp_gettext_is_ajax_on_frontend ) {
            $trp             = TRP_Translate_Press::get_trp_instance();
            if ( !$this->gettext_manager ) {
                $this->gettext_manager = $trp->get_component( 'gettext_manager' );
            }
            if ( !$this->gettext_manager->is_domain_loaded_in_locale( $domain, $current_locale ) ) {
                $translation = $text;
            }

            $db_id                 = '';
            if ( !$this->skip_gettext_querying ) {
                global $trp_translated_gettext_texts, $trp_all_gettext_texts;

                $found_in_db = false;

                /* initiate trp query object */
                if (!$this->trp_query) {
                    $trp = TRP_Translate_Press::get_trp_instance();
                    $this->trp_query = $trp->get_component('query');
                }

                if ( !isset( $trp_all_gettext_texts ) ) {
                    $trp_all_gettext_texts = array();
                }

                if ( !empty( $trp_translated_gettext_texts ) ) {
                    if ( isset( $trp_translated_gettext_texts[ $context . '::' . $plural_form . '::' . $domain . '::' . $text ] ) ) {
                        $trp_translated_gettext_text = $trp_translated_gettext_texts[ $context . '::' . $plural_form  . '::' . $domain . '::' . $text ];

                        if (!empty($trp_translated_gettext_text['translated']) && $translation != $trp_translated_gettext_text['translated'] && $this->is_sprintf_compatible( $trp_translated_gettext_text['translated'], $text ) ) {
                            $translation = str_replace(trim($text), trp_sanitize_string($trp_translated_gettext_text['translated']), $text);
                        }
                        $db_id       = $trp_translated_gettext_text['id'];
                        $found_in_db = true;
                        // update the db if a translation appeared in the po file later
                        if ( empty( $trp_translated_gettext_text['translated'] ) && $translation != $text && $translation != $original_plural ) {
                            $gettext_insert_update = $this->trp_query->get_query_component('gettext_insert_update');
                            $gettext_insert_update->update_gettext_strings( array(
                                array(
                                    'id'          => $db_id,
                                    'translated'  => $translation,
                                    'status'      => $this->trp_query->get_constant_human_reviewed(),
                                )
                            ), $current_locale, array('id', 'translated', 'status') );
                        }
                    }
                }

                if ( !$found_in_db ) {
                    if ( !in_array( array(
                        'original'    => $text,
                        'translated'  => $translation,
                        'domain'      => $domain,
                        'context'     => $context,
                        'plural_form' => $plural_form

                    ), $trp_all_gettext_texts )
                    ) {
                        $translation = $this->maybe_get_older_version_translation($translation, $text, $domain, $context , $original_plural, $plural_form );

                        $trp_all_gettext_texts[] = array(
                            'original'    => $text,
                            'translated'  => $translation,
                            'domain'      => $domain,
                            'context'     => $context,
                            'plural_form' => $plural_form
                        );
                        $gettext_insert_update = $this->trp_query->get_query_component('gettext_insert_update');
                        $db_id = $gettext_insert_update->insert_gettext_strings( array(
                            array(
	                            'original'        => $text,
	                            'translated'      => ( $translation != $text && $translation != $original_plural ) ? $translation : '',
	                            'domain'          => $domain,
	                            'context'         => $context,
	                            'plural_form'     => $plural_form,
	                            'original_plural' => $original_plural
                            )
                        ), $current_locale );
                        /* insert it in the global of translated because now it is in the database */
                        $trp_translated_gettext_texts[ $context . '::' . $plural_form . '::' . $domain . '::' . $text ] = array(
                            'id'          => $db_id,
                            'original'    => $text,
                            'translated'  => ( $translation != $text && $translation != $original_plural ) ? $translation : '',
                            'domain'      => $domain,
                            'context'     => $context,
                            'plural_form' => $plural_form
                        );
                    }
                }

                $trp = TRP_Translate_Press::get_trp_instance();
                if ( !$this->machine_translator ) {
                    $this->machine_translator = $trp->get_component( 'machine_translator' );
                }
                if ( !$this->trp_languages ) {
                    $this->trp_languages = $trp->get_component( 'languages' );
                }
                if ( !$this->machine_translation_codes ) {
                    $this->machine_translation_codes = $this->trp_languages->get_iso_codes( $this->settings['translation-languages'] );
                }
                /* We assume Gettext strings are in English so don't automatically translate into English */
                if ( $this->machine_translation_codes[ $TRP_LANGUAGE ] != 'en' && $this->machine_translator->is_available( array( $TRP_LANGUAGE ) ) ) {
                    global $trp_gettext_strings_for_machine_translation;
                    if ( $text == $translation || $original_plural == $translation ) {
                        /* The string looks untranslated to us because WordPress handed us a translation equal
                         * to the original. That happens both when the .po/.mo has no entry AND when it has an
                         * entry whose msgstr equals the msgid (e.g. WooCommerce "Åland Islands"). The latter is
                         * an intentional localization and must NOT be sent to machine translation. If the loaded
                         * catalog actually contains an entry for this string, persist it as a reviewed
                         * translation so the empty-'translated' guard below permanently excludes it on future
                         * loads, and skip the machine-translation queue. */
                        if ( $db_id && $this->gettext_string_has_catalog_translation( $domain, $text, $context, $original_plural ) ) {
                            foreach ( $trp_translated_gettext_texts as $key => $trp_translated_gettext_text ) {
                                if ( $trp_translated_gettext_text['id'] == $db_id ) {
                                    if ( $trp_translated_gettext_text['translated'] == '' ) {
                                        $gettext_insert_update = $this->trp_query->get_query_component( 'gettext_insert_update' );
                                        $gettext_insert_update->update_gettext_strings( array(
                                            array(
                                                'id'         => $db_id,
                                                'translated' => $translation,
                                                'status'     => $this->trp_query->get_constant_human_reviewed(),
                                            )
                                        ), $current_locale, array( 'id', 'translated', 'status' ) );
                                        $trp_translated_gettext_texts[ $key ]['translated'] = $translation;
                                    }
                                    break;
                                }
                            }
                        } else {
                            foreach ( $trp_translated_gettext_texts as $trp_translated_gettext_text ) {
                                if ( $trp_translated_gettext_text['id'] == $db_id ) {
                                    if ( $trp_translated_gettext_text['translated'] == '' && !isset( $trp_gettext_strings_for_machine_translation[ $db_id ] ) ) {
                                        $trp_gettext_strings_for_machine_translation[ $db_id ] = array(
                                            'id'         => $db_id,
                                            'original'   => $text,
                                            'translated' => '',
                                            'domain'     => $domain,
                                            'status'     => $this->trp_query->get_constant_machine_translated(),
                                            'context'     => $context,
                                            'plural_form' => $plural_form,
                                            'original_plural' => $original_plural
                                        );
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            $blacklist_functions = apply_filters( 'trp_gettext_blacklist_functions', array(
                'wp_enqueue_script',
                'wp_enqueue_scripts',
                'wp_editor',
                'wp_enqueue_media',
                'wp_register_script',
                'wp_print_scripts',
                'wp_localize_script',
                'wp_print_media_templates',
                'get_bloginfo',
                'wp_get_document_title',
                'wp_title',
                'wp_trim_words',
                'sanitize_title',
                'sanitize_title_with_dashes',
                'esc_url',
                'wc_get_permalink_structure' // make sure we don't touch the woocommerce permalink rewrite slugs that are translated
            ), $text, $translation, $domain );

            if ( version_compare( PHP_VERSION, '5.4.0', '>=' ) ) {
                $callstack_functions = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 15 );//set a limit if it is supported to improve performance
            } else {
                $callstack_functions = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS );
            }
            if ( !empty( $callstack_functions ) ) {
                foreach ( $callstack_functions as $callstack_function ) {
                    if ( in_array( $callstack_function['function'], $blacklist_functions ) ) {
                        $tp_last_gettext_processed = array( $context . '::' . $plural_form . '::' . $text . '::' . $domain => $translation );
                        return $translation;
                    }

                    /* make sure we don't touch the woocommerce process_payment function in WC_Gateway_Stripe. It does a wp_remote_post() call to stripe with localized parameters */
                    if ( $callstack_function['function'] == 'process_payment' && $callstack_function['class'] == 'WC_Gateway_Stripe' ) {
                        $tp_last_gettext_processed = array( $context . '::' . $plural_form . '::' . $text . '::' . $domain => $translation );
                        return $translation;
                    }

                }
            }
            unset( $callstack_functions );//maybe free up some memory
            global $trp_output_buffer_started;
            if ( did_action( 'init' ) && isset( $trp_output_buffer_started ) && $trp_output_buffer_started ) {//check here for our global $trp_output_buffer_started, don't wrap the gettexts if they are not processed by our cleanup callbacks for the buffers
                if ( ( !empty( $TRP_LANGUAGE ) && $this->settings["default-language"] != $TRP_LANGUAGE ) || ( isset( $_REQUEST['trp-edit-translation'] ) && $_REQUEST['trp-edit-translation'] == 'preview' ) ) {
                    //add special start and end tags so that it does not influence html in any way. we will replace them with < and > at the start of the translate function
	                /**
	                 * Compatibility with Woocomerce Payments
	                 *
	                 * In the file woocommerce-payments/includes/class-wc-payments-customer-service.php there is this line of code
	                 * $description = sprintf( __( 'Name: %1$s, Username: %2$s', 'woocommerce-payments' ), $name, $wc_customer->get_username() ); that should return admin or guest
	                 * but for some reason it returns our gettext string without the stripped gettext.
	                 */

	                /**
	                 * The bare year format ( 'Y' ) translated via _x() with a date/time format context must not be
	                 * wrapped, otherwise the gettext markers are interpreted as format characters by date_i18n() /
	                 * wp_date() and the output is broken (e.g. twentytwenty footer: _x( 'Y', 'copyright date format',
	                 * 'twentytwenty' )). We restrict this to the exact 'Y' text so that date formats which contain
	                 * actual translatable text (month or day names) keep being wrapped and translated normally and
	                 * are not re-sent to automatic translation on every request.
	                 *
	                 * Note: we intentionally do not expose a dedicated filter here because this block runs on every
	                 * gettext string; the existing 'trp_process_gettext_tags' filter below can be used to customize
	                 * the wrapping behaviour without the per-call overhead.
	                 */
	                $is_date_format_context = $text === 'Y' && (
		                stripos( $context, 'date format' ) !== false ||
		                stripos( $context, 'time format' ) !== false
	                );

	                if ( !$is_date_format_context && ( ($text != 'Name: %1$s, Username: %2$s' && $text != 'Name: %1$s, Guest' && $domain == 'woocommerce-payments') || $domain != 'woocommerce-payments') ) {
		                $translation = apply_filters( 'trp_process_gettext_tags', '#!trpst#trp-gettext data-trpgettextoriginal=' . $db_id . '#!trpen#' . $translation . '#!trpst#/trp-gettext#!trpen#', $translation, $this->skip_gettext_querying, $text, $domain );
	                }
                }
            }
        }
        $tp_last_gettext_processed = array( $context . '::' . $plural_form . '::' . $text . '::' . $domain => $translation );
        return $translation;
    }

    /**
     * caller for woocommerce domain texts
     * @param $translation
     * @param $text
     * @param $domain
     * @return string
     */
    public function woocommerce_process_gettext_strings( $translation, $text, $domain ) {
        if ( $domain === 'woocommerce' ) {
            $translation = $this->process_gettext_strings( $translation, $text, $domain );
        }
        return $translation;
    }

    /**
     * Function that filters gettext strings with context _x
     * @param $translation
     * @param $text
     * @param $context
     * @param $domain
     * @return string
     */
    public function process_gettext_strings_with_context( $translation, $text, $context, $domain ) {
        $translation = $this->process_gettext_strings( $translation, $text, $domain, $context );
        return $translation;
    }

    /**
     * caller for woocommerce domain texts with context
     */
    public function woocommerce_process_gettext_strings_with_context( $translation, $text, $context, $domain ) {
        if ( $domain === 'woocommerce' ) {
            $translation = $this->process_gettext_strings_with_context( $translation, $text, $context, $domain );
        }
        return $translation;
    }

    /**
     * function that filters the _n translations
     * @param $translation
     * @param $single
     * @param $plural
     * @param $number
     * @param $domain
     * @return string
     */
    public function process_ngettext_strings( $translation, $single, $plural, $number, $domain ) {
        $translation = $this->process_gettext_strings( $translation, $single, $domain, 'trp_context', $number, $plural );
        return $translation;
    }

    /**
     * caller for woocommerce domain numeric texts
     */
    public function woocommerce_process_ngettext_strings( $translation, $single, $plural, $number, $domain ) {
        if ( $domain === 'woocommerce' ) {
            $translation = $this->process_ngettext_strings( $translation, $single, $plural, $number, $domain );
        }

        return $translation;
    }

    /**
     * function that filters the _nx translations
     * @param $translation
     * @param $single
     * @param $plural
     * @param $number
     * @param $context
     * @param $domain
     * @return string
     */
    public function process_ngettext_strings_with_context( $translation, $single, $plural, $number, $context, $domain ) {
        $translation = $this->process_gettext_strings( $translation, $single, $domain, $context, $number, $plural );
        return $translation;
    }

    /**
     * caller for woocommerce domain numeric texts with context
     */
    public function woocommerce_process_ngettext_strings_with_context( $translation, $single, $plural, $number, $context, $domain ) {
        if ( $domain === 'woocommerce' ) {
            $translation = $this->process_ngettext_strings_with_context( $translation, $single, $plural, $number, $context, $domain );
        }
        return $translation;
    }

    /** Caller for gettext with no context and no plural.
     * Can't call process_gettext_strings directly due to incorrect parameter number
     *
     * @param $translation
     * @param $text
     * @param $domain
     * @return string
     */
    public function process_gettext_strings_no_context( $translation, $text, $domain ){
        $translation = $this->process_gettext_strings( $translation, $text, $domain );
        return $translation;
    }

	 /**
	  * Caller for woocommerce domain with no context and no plural
	  * Can't call process_gettext_strings directly due to incorrect parameter number
	  */
    public function woocommerce_process_gettext_strings_no_context( $translation, $text, $domain )
    {
        if ($domain === 'woocommerce') {
            $translation = $this->process_gettext_strings($translation, $text, $domain);
        }
        return $translation;
    }

	/**
	 * If we have a translation without context and without plural form then return that translation
	 *
	 * @param $translation
	 * @param $text
	 * @param $domain
	 * @param $context
	 * @param $original_plural
	 * @param $plural_form
	 *
	 * @return string
	 */
    public function maybe_get_older_version_translation($translation, $text, $domain, $context , $original_plural, $plural_form){

        global $trp_translated_gettext_texts;
        if ( $context == 'trp_context' && $original_plural === null ){
            return $translation;
        }
        if ( $original_plural !== null && $plural_form != 0 ){
            $text = $original_plural;
        }

        if ( isset( $trp_translated_gettext_texts[ 'trp_context' . '::' . 0 . '::' . $domain . '::' . $text ] ) &&
            !empty($trp_translated_gettext_texts[ 'trp_context' . '::' . 0 . '::' . $domain . '::' . $text ]['translated']) &&
            $this->is_sprintf_compatible( $trp_translated_gettext_texts[ 'trp_context' . '::' . 0 . '::' . $domain . '::' . $text ]['translated'], $text )
        ){
            $translation = str_replace(trim($text), trp_sanitize_string($trp_translated_gettext_texts[ 'trp_context' . '::' . 0 . '::' . $domain . '::' . $text ]['translated']), $text);
        }

        return $translation;
    }

    public function is_sprintf_compatible($string, $original_text = null){

        if (! apply_filters('trp_check_sprintf_compatibility', true ) ){
            return true;
        }

        if ( $original_text !== null ) {
            // Fast path: no '%' in either string means no placeholders to compare.
            if ( strpos( $original_text, '%' ) === false && strpos( $string, '%' ) === false ) {
                return true;
            }
            // sprintf placeholder grammar: %[argnum$][flags][width][.precision]specifier
            $pattern = "/%(?:\d+\\\$)?[-+0 #]*(?:'.)?\d*(?:\.\d+)?[bcdeEfFgGhHosuxX%]/";

            preg_match_all( $pattern, $original_text, $original_matches );
            preg_match_all( $pattern, $string, $translated_matches );

            // %% is a literal percent, not an argument consumer.
            $original_placeholders   = array_values( array_filter( $original_matches[0],   function( $p ) { return $p !== '%%'; } ) );
            $translated_placeholders = array_values( array_filter( $translated_matches[0], function( $p ) { return $p !== '%%'; } ) );

            sort( $original_placeholders );
            sort( $translated_placeholders );
            return $original_placeholders === $translated_placeholders;
        }

        // Fallback when the original is unavailable: only catches malformed format
        // specifiers and translations with >200 placeholders.
        $arr = array(1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1);
        $is_compatible = true;
        try{
            $test = sprintf($string, ...$arr);
        }catch(Throwable $e){
            $is_compatible = false;
        }
        return $is_compatible;
    }
}
