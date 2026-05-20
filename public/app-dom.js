// =====================================================
        // FIREBASE — use globals set by head initialization
        // =====================================================
        // Re-attempt init in case SDK loaded after head script ran
        if (!window._firebaseLoaded && typeof firebase !== 'undefined') {
            window._initFirebase();
        }
        // Local aliases that always point to working implementations
        let fbAuth    = window.fbAuth;
        let fbDb      = window.fbDb;
        let fbStorage = window.fbStorage;
        // Keep them in sync if Firebase loads asynchronously
        Object.defineProperty(window, 'fbAuth',    { get: () => fbAuth,    set: v => { fbAuth = v; },    configurable: true });
        Object.defineProperty(window, 'fbDb',      { get: () => fbDb,      set: v => { fbDb = v; },      configurable: true });
        Object.defineProperty(window, 'fbStorage', { get: () => fbStorage, set: v => { fbStorage = v; }, configurable: true });

        function _serverTimestamp() {
            try {
                if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue)
                    return firebase.firestore.FieldValue.serverTimestamp();
            } catch(e) {}
            return new Date();
        }

        // =====================================================
        // CLOUDINARY CONFIG — read lazily inside each call so
        // /api/config always has time to load before first upload.
        // =====================================================
        function _getCloudinaryConfig() {
            const _cloud = window._appConfig && window._appConfig.cloudinary;
            const cloud  = (_cloud && _cloud.cloud)  || '';
            const preset = (_cloud && _cloud.preset) || '';
            const url    = cloud
                ? 'https://api.cloudinary.com/v1_1/' + cloud + '/auto/upload'
                : '';
            return { cloud, preset, url };
        }

        // Expose uploadToCloudinary globally so secondary scripts can call it
        window.uploadToCloudinary = async function uploadToCloudinary(file, onProgress) {
            if (!file || !(file instanceof File)) {
                // Not a real file — return as-is if it's already a URL string
                if (typeof file === 'string') return file;
                return Promise.resolve(URL.createObjectURL(file));
            }

            // Read config NOW (not at parse time) so /api/config is already loaded
            const { preset: CLOUDINARY_PRESET, url: CLOUDINARY_URL } = _getCloudinaryConfig();

            if (!CLOUDINARY_URL) {
                console.error('[Cloudinary] ❌ Config not loaded — upload_preset or cloud name missing. Check /api/config is returning cloudinary values.');
                if (typeof showNotification === 'function') showNotification('Upload failed: server config not ready. Please try again in a moment.', 'error');
                return Promise.reject(new Error('Cloudinary config not loaded'));
            }

            // Always create a local blob URL as immediate fallback
            const localUrl = URL.createObjectURL(file);

            return new Promise((resolve) => {
                // If no network or Cloudinary unreachable, resolve with local URL after 10s
                const fallbackTimer = setTimeout(() => {
                    console.warn('[Upload] Cloud upload timed out — using local URL');
                    resolve(localUrl);
                }, 10000); // 10 second max wait

                const fd = new FormData();
                fd.append('file', file);
                fd.append('upload_preset', CLOUDINARY_PRESET);
                fd.append('tags', 'empyrean_app');
                const xhr = new XMLHttpRequest();
                xhr.open('POST', CLOUDINARY_URL, true);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        if (onProgress) onProgress(pct);
                        document.querySelectorAll('.upload-progress-bar').forEach(bar => {
                            bar.style.width = pct + '%';
                            bar.style.background = 'linear-gradient(90deg,#00897B,#4CAF50)';
                        });
                    }
                };
                xhr.onload = () => {
                    clearTimeout(fallbackTimer);
                    if (xhr.status === 200) {
                        try {
                            const res = JSON.parse(xhr.responseText);
                            const cloudUrl = res.secure_url || localUrl;
                            // Upload monitoring log
                            console.info('[Cloudinary] ✅ Upload successful:', {
                                public_id: res.public_id,
                                format: res.format,
                                size_kb: Math.round((res.bytes||0)/1024),
                                url: cloudUrl.substring(0, 60) + '...'
                            });
                            // Track upload count for monitoring
                            window._cloudinaryUploads = (window._cloudinaryUploads || 0) + 1;
                            resolve(cloudUrl);
                        } catch(e) { resolve(localUrl); }
                    } else {
                        console.warn('[Cloudinary] ⚠ Upload error ' + xhr.status + ' — using local blob URL');
                        resolve(localUrl);
                    }
                };
                xhr.onerror = () => { clearTimeout(fallbackTimer); resolve(localUrl); };
                xhr.ontimeout = () => { clearTimeout(fallbackTimer); resolve(localUrl); };
                xhr.timeout = 10000;
                xhr.send(fd);
            });
        };
        const uploadToCloudinary = window.uploadToCloudinary;

        async function uploadMediaFilesToCloudinary(files, onProgress) {
            if (!files || files.length === 0) return [];
            const uploads = Array.from(files).map(async (file, idx) => {
                if (!(file instanceof File)) {
                    return file._cloudUrl || (typeof file === 'string' ? file : (file.url || ''));
                }
                // Validate file size (max 100MB)
                if (file.size > 100 * 1024 * 1024) {
                    if (typeof showNotification === 'function') showNotification(`"${file.name}" is too large (max 100MB).`, 'error');
                    return URL.createObjectURL(file);
                }
                try {
                    const url = await uploadToCloudinary(file, (pct) => {
                        if (onProgress) onProgress(idx, pct);
                    });
                    file._cloudUrl = url;
                    return url;
                } catch(err) {
                    console.warn('Upload error for file', file.name, err.message);
                    if (typeof showNotification === 'function') showNotification('Upload failed: ' + err.message, 'error');
                    return file._cloudUrl || URL.createObjectURL(file);
                }
            });
            return Promise.all(uploads);
        }
        window.uploadMediaFilesToCloudinary = uploadMediaFilesToCloudinary;

        // =====================================================
        // FLUTTERWAVE PAYMENT GATEWAY — keys from /api/config
        // =====================================================
        const _flw = window._appConfig && window._appConfig.flutterwave;
        const FLW_PUBLIC_KEY = (_flw && _flw.publicKey) || '';
        // FLW_SECRET_KEY and FLW_ENCRYPTION_KEY live only on the server.
        // Transaction verification is proxied through /api/flw/verify.
        function initiateFlutterwavePayment(opts) {
            const txRef = 'EMPY-' + Date.now() + '-' + Math.floor(Math.random()*10000);
            if (typeof FlutterwaveCheckout === 'undefined') {
                console.warn('Flutterwave not loaded — retrying...');
                // Dynamically load if missed on page load
                const s = document.createElement('script');
                s.src = 'https://checkout.flutterwave.com/v3.js';
                s.onload = function() { initiateFlutterwavePayment(opts); };
                s.onerror = function() { if (opts.onFailure) opts.onFailure({ status: 'error', message: 'Payment gateway unavailable' }); };
                document.body.appendChild(s);
                return;
            }
            FlutterwaveCheckout({
                public_key: FLW_PUBLIC_KEY,
                tx_ref: txRef,
                amount: opts.amount,
                currency: opts.currency || 'NGN',
                payment_options: 'card,ussd,banktransfer,mobilemoney',
                customer: {
                    email: opts.email || (window.userState && window.userState.email) || 'user@empyrean.com',
                    phone_number: opts.phone || (window.userState && window.userState.phone) || '',
                    name: opts.name || (window.userState && window.userState.fullName) || 'Empyrean User'
                },
                customizations: {
                    title: 'Empyrean Humanitarian Platform',
                    description: opts.description || 'Payment',
                    logo: window._empyreanLogoSrc || ''
                },
                meta: { verified_server_side: true },   // verification via /api/flw/verify
                callback: function(response) {
                    if (response.status === 'successful') {
                        fbDb.collection('flw_transactions').doc(txRef).set({
                            txRef, amount: opts.amount, currency: opts.currency || 'NGN',
                            purpose: opts.purpose || 'general', status: 'held',
                            createdAt: _serverTimestamp()
                        }).catch(e => console.error('FLW tx save error:', e));
                        if (opts.onSuccess) opts.onSuccess(response, txRef);
                    } else {
                        if (opts.onFailure) opts.onFailure(response);
                    }
                },
                onclose: function() { if (opts.onClose) opts.onClose(); }
            });
        }

        // Firebase user helpers
        async function saveUserToFirestore(uid, userData) {
            // Ensure real Firebase is ready before saving
            if (!window._firebaseLoaded) {
                console.warn('[saveUser] Firebase not ready — queuing retry in 2s');
                return new Promise((resolve) => {
                    setTimeout(async () => { try { await saveUserToFirestore(uid, userData); } catch(e){} resolve(); }, 2000);
                });
            }
            const safe = { ...userData };
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { if (safe[k] instanceof Set) safe[k] = [...safe[k]]; });
            delete safe.password;
            safe.updatedAt = _serverTimestamp();
            try {
                await fbDb.collection('users').doc(uid).set(safe, { merge: true });
                console.log('[Firestore] ✅ User profile saved for uid:', uid);
            } catch(err) {
                console.error('[Firestore] ❌ User save failed:', err.message);
                throw err;
            }
        }
        async function loadUserFromFirestore(uid) {
            const doc = await fbDb.collection('users').doc(uid).get();
            if (!doc.exists) return null;
            const data = doc.data();
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { data[k] = new Set(data[k] || []); });
            return data;
        }