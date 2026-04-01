(() => {
    const canUseStorage = (() => {
        try {
            const probeKey = '__app_utils_probe__';
            window.localStorage.setItem(probeKey, '1');
            window.localStorage.removeItem(probeKey);
            return true;
        } catch (error) {
            return false;
        }
    })();

    function debounce(fn, wait = 100) {
        let timeoutId = null;
        return function debounced(...args) {
            const context = this;
            window.clearTimeout(timeoutId);
            timeoutId = window.setTimeout(() => {
                fn.apply(context, args);
            }, wait);
        };
    }

    function createNamespacedStorage(key, options = {}) {
        const version = options.version || 1;
        const migrate = typeof options.migrate === 'function' ? options.migrate : null;

        function parseStoredValue(rawValue, fallbackValue) {
            if (!rawValue) {
                return fallbackValue;
            }

            try {
                const parsed = JSON.parse(rawValue);
                if (parsed && typeof parsed === 'object' && parsed.__version) {
                    if (parsed.__version === version) {
                        return parsed.data;
                    }
                    if (migrate) {
                        return migrate(parsed.data, parsed.__version);
                    }
                    return fallbackValue;
                }

                if (migrate) {
                    return migrate(parsed, 0);
                }
                return parsed;
            } catch (error) {
                console.warn(`Failed to parse storage key "${key}"`, error);
                return fallbackValue;
            }
        }

        return {
            get(fallbackValue) {
                if (!canUseStorage) {
                    return fallbackValue;
                }
                return parseStoredValue(window.localStorage.getItem(key), fallbackValue);
            },
            set(value) {
                if (!canUseStorage) {
                    return false;
                }
                try {
                    window.localStorage.setItem(key, JSON.stringify({
                        __version: version,
                        data: value,
                    }));
                    return true;
                } catch (error) {
                    console.warn(`Failed to save storage key "${key}"`, error);
                    return false;
                }
            },
            remove() {
                if (!canUseStorage) {
                    return;
                }
                window.localStorage.removeItem(key);
            },
        };
    }

    function escapeHTML(value) {
        if (value === null || value === undefined) {
            return '';
        }
        const div = document.createElement('div');
        div.textContent = String(value);
        return div.innerHTML;
    }

    function downloadBlob(content, fileName, contentType) {
        const anchor = document.createElement('a');
        const blob = new Blob([content], { type: contentType });
        const url = URL.createObjectURL(blob);
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function downloadCanvas(canvas, fileName) {
        const anchor = document.createElement('a');
        anchor.href = canvas.toDataURL('image/png', 1.0);
        anchor.download = fileName;
        anchor.click();
    }

    window.AppUtils = {
        debounce,
        createNamespacedStorage,
        escapeHTML,
        downloadBlob,
        downloadCanvas,
    };
})();
