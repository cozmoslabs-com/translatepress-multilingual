<?php

class TRP_Woocommerce_Emails{

    public function __construct(){}

    public function initialize_hooks(){

        // In order for the email translation to work properly, WC_VERSION needs to be >= 6.8.0
        if( defined( 'WC_VERSION' ) && version_compare( WC_VERSION, '6.8.0' ) >= 0 ) {

            // Save user language on checkout
            add_action( 'woocommerce_checkout_update_order_meta', array( $this, 'save_language_on_checkout' ), 10, 2 );
            // Save current language for user every time wp_footer is loaded
            add_action( 'wp_footer', array( $this, 'save_current_language' ) );

            // WooCommerce email notifications
            add_action( 'woocommerce_order_status_processing_to_cancelled_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_on-hold_to_cancelled_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_completed_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_pending_to_on-hold_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_failed_to_on-hold_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_cancelled_to_on-hold_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_cancelled_to_processing_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_failed_to_processing_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_on-hold_to_processing_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_pending_to_processing_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_fully_refunded_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_partially_refunded_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_pending_to_failed_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_on-hold_to_failed_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_pending_to_completed_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_failed_to_completed_notification', array( $this, 'store_email_order_id' ), 5, 1 );
            add_action( 'woocommerce_order_status_cancelled_to_completed_notification', array( $this, 'store_email_order_id' ), 5, 1 );

            // WooCommerce emails when resent by admin
            add_action( 'woocommerce_before_resend_order_emails', array( $this, 'prepare_order_id_for_resend_emails' ), 5, 2 );
            // WooCommerce note to customer email
            add_action( 'woocommerce_new_customer_note_notification', array( $this, 'prepare_order_id_for_note_emails' ), 5, 1 );

            // Hijack execution to translate emails in user language accordingly
            add_filter( 'woocommerce_allow_switching_email_locale', array( $this, 'trp_woo_setup_locale' ), 10, 2 );
            add_filter( 'woocommerce_allow_restoring_email_locale', array( $this, 'trp_woo_restore_locale' ), 10, 2 );
        }
    }

    /**
     * Save user language on WooCommerce checkout
     *
     * @param $order_id
     * @param $posted
     * @return void
     */
    public function save_language_on_checkout( $order_id, $posted ) {
        global $TRP_LANGUAGE, $TRP_EMAIL_ORDER;
        $order = wc_get_order($order_id);
        $user_id = $order->get_user_id();
        $TRP_EMAIL_ORDER = $order_id;
        if( $user_id != 0 ){
            update_user_meta( $user_id, 'trp_language', $TRP_LANGUAGE );
            update_post_meta( $order_id, 'trp_language', $TRP_LANGUAGE );
        }
        else{
            update_post_meta( $order_id, 'trp_language', $TRP_LANGUAGE );
        }
    }

    /**
     * Save current user language
     *
     * The hook was added on 'wp_footer' to prevent logout or backend admin actions from resetting $TRP_LANGUAGE to TRP default language
     *
     * @return void
     */
    public function save_current_language(){
        global $TRP_LANGUAGE;
        $user_id = get_current_user_id();
        $language_meta = get_user_meta( $user_id, 'trp_language', true);
        if( $user_id > 0 && $language_meta != $TRP_LANGUAGE ){
            update_user_meta( $user_id, 'trp_language', $TRP_LANGUAGE );
        }
    }

    /**
     * Store order id in a separate global to access its value later in the execution
     *
     * @param $order_id
     * @return void
     */
    public function store_email_order_id( $order_id ) {
        global $TRP_EMAIL_ORDER;
        $TRP_EMAIL_ORDER = $order_id;
    }

    /**
     * Prepare order id for resend emails
     *
     * @param $order
     * @param $email_type
     * @return void
     */
    public function prepare_order_id_for_resend_emails( $order, $email_type ) {
        if( $email_type == 'customer_invoice' )
            $this->store_email_order_id( $order->get_id() );
    }

    /**
     * Prepare order id for note emails
     *
     * @param $note_and_order_id
     * @return void
     */
    public function prepare_order_id_for_note_emails( $note_and_order_id ) {
        $this->store_email_order_id( $note_and_order_id['order_id'] );
    }

    /**
     * Set the language for WooCommerce emails according to the user information:
     * user profile language for admin AND language metadata for customer
     *
     * @param $bool
     * @param $wc_email
     * @return false
     */
    public function trp_woo_setup_locale( $bool, $wc_email ) {
        global $TRP_LANGUAGE, $TRP_LANGUAGE_COPY;
        $is_customer_email  = $wc_email->is_customer_email();
        $recipients         = explode( ',', $wc_email->get_recipient() );
        $language           = $TRP_LANGUAGE;
        $user_id            = 0;

        if( $is_customer_email ){
            global $TRP_EMAIL_ORDER;
            $order = wc_get_order( $TRP_EMAIL_ORDER );
            if ( $order ) {
                $user_id = $order->get_user_id();
                if ( $user_id > 0 ) {
                    $language = get_user_meta( $user_id, 'trp_language', true );
                } else {
                    $language = get_post_meta( $TRP_EMAIL_ORDER, 'trp_language', true );
                }
            }
        }
        else{
            if( count( $recipients ) == 1 ){
                $registered_user = get_user_by( 'email', $recipients[0] );
                if( $registered_user ){
                    $language = $registered_user->locale;
                }
            }
        }

        $language = apply_filters( 'trp_woo_email_language', $language, $is_customer_email, $recipients, $user_id );
        $language = $this->validate_language( $language );

        $TRP_LANGUAGE = $language;
        $TRP_LANGUAGE_COPY = $language;

        // Because of 'trp_before_translate_content' filter function is_ajax_frontend() is called and it changes the global $TRP_LANGUAGE according to the url from which it was called.
        // Function trp_reset_language() is added on the hook in order to set global $TRP_LANGUAGE according to our need for the email language instead.
        add_filter( 'trp_before_translate_content', array( $this, 'trp_reset_language' ), 99999999 );

        switch_to_locale($language);
        add_filter( 'plugin_locale', array( $this, 'trp_get_locale' ), 99999999);
        WC()->load_plugin_textdomain();

        // calls necessary because the default additional_content field of an email is localized before this point and stored in a variable in the previous locale
        $wc_email->init_form_fields();
        $wc_email->init_settings();

        return false;

    }

    /**
     * Return a valid TRP language in which the email will be sent
     *
     * @param $language
     * @return mixed
     */
    public function validate_language( $language ){
        $trp = TRP_Translate_Press::get_trp_instance();
        $trp_settings = $trp->get_component( 'settings' );
        $settings = $trp_settings->get_settings();
        if( empty( $language ) || !in_array( $language, $settings['translation-languages'] ) ){
            $language = $settings['default-language'];
        }
        return $language;
    }

    /**
     * Return $TRP_LANGUAGE as plugin locale
     *
     * @return mixed
     */
    public function trp_get_locale() {
        global $TRP_LANGUAGE;
        return $TRP_LANGUAGE;
    }


    /**
     * The value of $TRP_LANGUAGE is set according to the url, which can be problematic in some cases when sending emails
     * Restore the $TRP_LANGUAGE value in which email will be sent
     *
     * @param $output
     * @return mixed
     */
    public function trp_reset_language( $output ){
        global $TRP_LANGUAGE, $TRP_LANGUAGE_COPY;
        $TRP_LANGUAGE = $TRP_LANGUAGE_COPY;
        return $output;
    }

    /**
     * Restore locale after email is sent
     *
     * @param $bool
     * @param $wc_email
     * @return false
     */
    public function trp_woo_restore_locale( $bool, $wc_email ) {

        remove_filter( 'trp_before_translate_content', array( $this, 'trp_reset_language' ) );

        restore_previous_locale();
        remove_filter( 'plugin_locale', array( $this, 'trp_get_locale' ) );
        WC()->load_plugin_textdomain();

        return false;

    }

}