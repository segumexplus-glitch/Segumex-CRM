window.SegumexUI = {
    /**
     * Pone un botón en estado de carga.
     * @param {string|HTMLElement} btnSelector - ID del botón o el elemento DOM mismo.
     * @param {string} loadingText - Texto a mostrar (ej: "Guardando...").
     */
    setLoading: function (btnSelector, loadingText = "Procesando...") {
        const btn = (typeof btnSelector === 'string')
            ? document.getElementById(btnSelector)
            : btnSelector;

        if (!btn) return;

        // Guardar estado original
        btn.dataset.originalText = btn.innerHTML;
        btn.dataset.originalClasses = btn.className;

        // Deshabilitar y cambiar estilo
        btn.disabled = true;
        btn.classList.add('btn-loading');

        // Inyectar spinner y texto
        btn.innerHTML = `<span class="spinner"></span> ${loadingText}`;
    },

    /**
     * Restaura un botón a su estado original.
     * @param {string|HTMLElement} btnSelector - ID del botón o el elemento DOM mismo.
     */
    resetLoading: function (btnSelector) {
        const btn = (typeof btnSelector === 'string')
            ? document.getElementById(btnSelector)
            : btnSelector;

        if (!btn) return;

        // Restaurar estado
        if (btn.dataset.originalText) {
            btn.innerHTML = btn.dataset.originalText;
        }

        btn.disabled = false;
        btn.classList.remove('btn-loading');
    }
};
