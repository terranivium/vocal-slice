        // Theme Management System
        const THEME_MODE_KEY = 'themeMode'; // 'light' or 'dark'
        const LIGHT_THEME_KEY = 'lightTheme'; // 'latte', 'latte-soft'
        const DARK_THEME_KEY = 'darkTheme'; // 'mocha', 'frappe', 'macchiato'
        
        // Processing settings keys
        const DEVICE_KEY = 'processingDevice'; // 'webgpu', 'wasm'
        const MODEL_KEY = 'whisperModel';
        const LANGUAGE_KEY = 'language';
        
        // Initialize theme preferences
        function initializeThemePreferences() {
            // Detect system preference
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            const systemPreference = prefersDark ? 'dark' : 'light';
            
            // Load saved preferences or use system preference as default
            const mode = localStorage.getItem(THEME_MODE_KEY) || systemPreference;
            const lightTheme = localStorage.getItem(LIGHT_THEME_KEY) || 'latte-soft';
            const darkTheme = localStorage.getItem(DARK_THEME_KEY) || 'mocha';
            
            // Set select values
            const lightSelect = document.getElementById('light-theme-select');
            const darkSelect = document.getElementById('dark-theme-select');
            if (lightSelect) lightSelect.value = lightTheme;
            if (darkSelect) darkSelect.value = darkTheme;
            
            // Apply the theme
            applyTheme(mode, lightTheme, darkTheme);
            
            // Listen for system theme changes
            if (window.matchMedia) {
                const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
                mediaQuery.addEventListener('change', (e) => {
                    // Only auto-update if user hasn't manually set a preference
                    if (!localStorage.getItem(THEME_MODE_KEY)) {
                        const newMode = e.matches ? 'dark' : 'light';
                        applyTheme(newMode, lightTheme, darkTheme);
                    }
                });
            }
        }
        
        function applyTheme(mode, lightTheme, darkTheme) {
            const body = document.body;
            
            // Remove all theme classes
            body.classList.remove('theme-latte', 'theme-latte-soft', 'theme-frappe', 'theme-macchiato', 'theme-mocha');
            
            // Apply the appropriate theme
            if (mode === 'dark') {
                body.classList.add(`theme-${darkTheme}`);
            } else {
                body.classList.add(`theme-${lightTheme}`);
            }
            
            // Update icon
            updateThemeIcon(mode);

            // Redraw canvas waveform so it picks up new CSS colour variables
            if (typeof window.redrawWaveform === 'function') window.redrawWaveform();
        }
        
        function updateThemeIcon(mode) {
            const themeIcon = document.getElementById('theme-icon');
            if (!themeIcon) return;
            
            if (mode === 'dark') {
                themeIcon.className = 'ph-fill ph-moon';
            } else {
                themeIcon.className = 'ph-fill ph-sun';
            }
        }
        
        // Toggle between light and dark mode
        function toggleTheme() {
            const currentMode = localStorage.getItem(THEME_MODE_KEY) || 'dark';
            const newMode = currentMode === 'dark' ? 'light' : 'dark';
            
            const lightTheme = localStorage.getItem(LIGHT_THEME_KEY) || 'latte-soft';
            const darkTheme = localStorage.getItem(DARK_THEME_KEY) || 'mocha';
            
            localStorage.setItem(THEME_MODE_KEY, newMode);
            applyTheme(newMode, lightTheme, darkTheme);
        }
        
        // Update theme preferences from settings menu
        function updateThemePreferences() {
            const lightSelect = document.getElementById('light-theme-select');
            const darkSelect = document.getElementById('dark-theme-select');
            
            if (!lightSelect || !darkSelect) return;
            
            const lightTheme = lightSelect.value;
            const darkTheme = darkSelect.value;
            const currentMode = localStorage.getItem(THEME_MODE_KEY) || 'dark';
            
            // Save preferences
            localStorage.setItem(LIGHT_THEME_KEY, lightTheme);
            localStorage.setItem(DARK_THEME_KEY, darkTheme);
            
            // Apply the current mode with new theme
            applyTheme(currentMode, lightTheme, darkTheme);
        }
        
        // Make functions globally available
        window.toggleTheme = toggleTheme;
        window.updateThemePreferences = updateThemePreferences;
        // Used by app.js; must stay global now that this file is a bundled module.
        window.saveProcessingSettings = saveProcessingSettings;
        window.loadProcessingSettings = loadProcessingSettings;
        
        // Load theme immediately
        initializeThemePreferences();
        
        // Also initialize when DOM is ready (for safety)
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initializeThemePreferences);
        }
        
        // Processing Settings Functions
        function saveProcessingSettings() {
            const device = document.getElementById('device-select')?.value;
            const model = document.getElementById('model-select')?.value;
            const language = document.getElementById('language-select')?.value;
            
            if (device) localStorage.setItem(DEVICE_KEY, device);
            if (model) localStorage.setItem(MODEL_KEY, model);
            if (language) localStorage.setItem(LANGUAGE_KEY, language);
        }
        
        function loadProcessingSettings() {
            const savedDevice = localStorage.getItem(DEVICE_KEY);
            const savedModel = localStorage.getItem(MODEL_KEY);
            const savedLanguage = localStorage.getItem(LANGUAGE_KEY);
            
            const deviceSelect = document.getElementById('device-select');
            const modelSelect = document.getElementById('model-select');
            const languageSelect = document.getElementById('language-select');
            
            if (savedDevice && deviceSelect) {
                deviceSelect.value = savedDevice;
            }
            if (savedModel && modelSelect) {
                modelSelect.value = savedModel;
            }
            if (savedLanguage && languageSelect) {
                languageSelect.value = savedLanguage;
            }
        }
        
        // Load processing settings on startup
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', loadProcessingSettings);
        } else {
            loadProcessingSettings();
        }
