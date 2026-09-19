# Veldora demo readiness — 2026-09-20

**Sonuç: Kod kontrolleri PASS; tam canlı kabul BLOCKED.** Kontrol zamanı 20:56–20:57 UTC. Başlangıç: temiz `main`, `dcbe222a27c6e40e083b87a17e30bc603eddb420`; test edilen kod: `82d1f73db10baf22cb15a14f44c30127e74af059`. Origin: `https://github.com/lmcboyraz/veldora.git`. Push yapılmadı.

## Düzeltmeler ve kanıtlanan nedenler

- `app/page.tsx`, `lib/stellar.ts`, `lib/config.ts`: ana ekran iki sabit LP'yi okuyordu; bir okuma hatası tüm sonucu düşürüyordu. Artık `get_providers`, sağlayıcı başına sonuç/hata ve teyit edilmiş işlem ledger sınırı kullanılıyor. Router seçimi değişmedi.
- `app/page.tsx`: Fund → Send yalnız sekme değiştiriyordu. Artık mevcut tam tutar için quote ve bakiye yenileniyor; kapasite yoksa açık uyarı var. Tutar düzenlenince Continue çalışmaya devam ediyor; işlem başladıktan sonra eski fonlama mesajı gösterilmiyor.
- `app/page.tsx`: başarısız ilk/reconnect okumaları başlangıçtaki sıfırları veya eski bakiyeyi bırakabiliyordu. Okuma başında bakiye bilinmiyor; wallet/request kimliği eski yanıtları engelliyor. İmza öncesi okuma da aynı yolu kullanıyor. Confirmed trustline/Send/LP sonucu refresh hatasıyla failed olmuyor.
- `lib/anchor/server.ts`: dış capability limitleri tip doğrulaması olmadan string'e çevriliyordu. Nesne/array/null/boolean limitler reddediliyor; eksik limit desteği korunuyor. Bu, bildirilen “Invalid amount” kök nedeni olarak sunulmuyor.
- `components/liquidity-panel.tsx`: callback ref'i render yerine effect içinde güncelleniyor. `package.json`: Node 26'da dizin olarak test keşfi başarısızdı; test dosyası glob'u kullanılıyor. `app/layout.tsx`: mevcut favicon.svg bağlandı; tarayıcının favicon.ico 404'ü giderildi.
- Regresyonlar: `tests/anchor-flow.test.mjs`, `tests/fx-send.test.mjs`, `tests/fx-liquidity.test.mjs`; mock uyarlaması `tests/fx-quote-cycle.test.mjs`; ek wallet kabul kontrolleri `tests/fx-wallet.test.mjs`. Düzeltmelerden önce ilgili başarısızlıklar görüldü. Favicon için gerçek HTTP/head kontrolü kullanıldı.

## Son kod değişikliğinden sonraki komutlar

Node v26.3.0, `PATH=/opt/homebrew/bin:$PATH` ile:

| Komut | Sonuç |
|---|---|
| `npm run typecheck` | PASS, exit 0 |
| `npm run lint` | PASS, exit 0 |
| `npm test` | PASS, 103/103; atlanan yok |
| `npm run build` | PASS; >500 kB chunk ve vinext route sınıflandırma uyarıları |
| `(cd soroban && cargo test)` | PASS, router 18 + oracle 4; workspace dışı reference kontratları dahil değil |
| `npm run demo:preflight` | PASS, exit 0; 12 PASS, 1 TTL WARN, 0 FAIL |

Yerel kanıtlar: `outputs/demo-readiness-20260919/` altında altı komutun logları, test edilen dosyaların SHA-256 özeti, browser smoke script/JSON ve masaüstü/dar ekran görüntüleri var. Bu üretilmiş klasör ignored. Sonradan yalnız bu rapor eklendi.

## Kabul tablosu

| Kontrol | Durum | Kanıt / engel |
|---|---|---|
| Anchor “Invalid amount” gerçek kök nedeni | BLOCKED | Public price yanıtı incelendi; hatayı veren authenticated firm quote/status yanıtına erişim yok. Aşağıdaki açık tutar kısıtı giderilmiş sayılmıyor. |
| Anchor expiry, pending deposit, recovery, exact issuer/recipient | PASS (otomatik) | Anchor session/flow/recovery testleri; kayıp deposit cevabı duplicate oluşturmuyor. Gerçek oturum provası bekliyor. |
| Fund → Send; kapasite aşımı | PASS (otomatik + salt-okunur) | 1/60 USDC regresyonu; canlı 1 USDC → EURC quote başarılı, 60 için Contract #8. Aktif USD/EUR limitleri 10, 10, 3 USDC; beklenen demo kapasite sınırı. |
| Bakiye hatası, ilk bağlantı/reconnect/wallet değişimi, geç RPC, confirmed refresh | PASS (otomatik) | fx-send ve liquidity-panel regresyonları; bilinmeyen bakiye sıfır olmuyor. |
| Sender/recipient, yanlış ağ, imza reddi, trustline/bakiye eksiği | PASS (otomatik) | fx-send, fx-wallet, fx-ui, fx-liquidity; wallet adaptörü test doubles kullanıyor, gerçek imza değil. |
| 12 yön quote | PASS (Testnet simulation) | 1 ve 5 birimde 12/12 + 12/12; oracle/router hatası yok. |
| Yeni LP görünümü/seçimi, deposit/withdraw, envanter | PASS (otomatik + okuma) | UI'da zincirdeki 4 LP; kısmi hata regresyonu; Rust kayıt, route ve custody testleri. Bu koşuda canlı LP yazımı yapılmadı. |
| Fee retention/reuse, doğru LP, çift çekim olmaması | PASS (Rust) | `retained_fee_funds_the_next_swap_without_double_credit_or_extra_withdrawal_rights` ve farklı LP/rollback testleri. |
| Timeout/reload/Check transaction | PASS (otomatik) | fx-submission, fx-quote-cycle, tx-outcome ve LP recovery: aynı hash, belirsizlikte yeniden imza/submission yok. |
| Yerel UI, desktop/dar ekran, runtime | PASS (tarayıcı) | Mevcut localhost:3017/PID 40389 kullanıldı. 1440/390 px, üç sekme, taşma yok, JS exception/console.error yok. Tek HTTP 400 kasıtlı geçersiz-wallet güvenlik probu. |
| Sunum URL'si ile sürüm eşleşmesi | BLOCKED | Sites kaydındaki eski Rise FX v1 URL'si bulundu; anonim erişim HTTP 401. Güncel Veldora ile eşleşmesi doğrulanmadı, deploy yapılmadı. |
| Kullanıcı imzalı direct/two-hop, gerçek Fund/LP kabulü ve prova videosu | BLOCKED | Gerçek Chrome'da Apple Events JavaScript erişimi kapalı; cüzdan/pending durumu okunamadı. Aşağıdaki somut bağlantı adımı bekliyor. |
| İmzasız kayıt/MP4 denemesi | PASS (yalnız video aracı) | 12 sn, 1280×900, 8 fps H.264 MP4; 1/5/9. saniye kareleri dosyadan çözülerek kontrol edildi. İzole Chromium, cüzdan bağlı değil; gerçek kabul kanıtı değil. |

## Anchor tutar incelemesinin sınırı

20:57 UTC public `GET /sep38/price`: `50` ve `50.00` isteği → `sell_amount: "50.00"`, `buy_amount: "1.0198263"`, `fee.total: "0.25"`. Bu endpoint'e `50.0000000` **girdi** vermek HTTP 400 döndürüyor; bu gözlem authenticated **yanıt** biçimini kanıtlamaz. Güvenli alanlar `anchor-public-amounts.json` içinde.

[Anchor quote kaynağı](https://github.com/kaankacar/tr-mock-anchor/blob/81eef8af29fa8fdc6f6596a4472c8bedb5381668/src/routes/sep38.ts) ve [status kaynağı](https://github.com/kaankacar/tr-mock-anchor/blob/81eef8af29fa8fdc6f6596a4472c8bedb5381668/src/core/sepstatus.ts) iki ondalıklı TRY üretimini destekliyor. Mevcut Veldora `tryAmount` kontrolü hem quote.sell_amount hem status.amount_in için iki ondalıkla sınırlı: **dış yanıtta 50.0000000 eşdeğerliği henüz karşılanmıyor**; 50.001 reddediliyor, yuvarlama yok. Bildirilen hatanın gerçek yanıtı olmadan varsayıma dayalı normalizasyon uygulanmadı. Gerekli sonraki kanıt yalnız tutar alanları/tipleri ve hatanın adımı; token, Authorization, signed challenge veya kişisel veri değil.

## Gerçek işlemler ve demo öncesi kalanlar

Bu koşuda hiçbir zincir işlemi imzalanmadı/gönderilmedi. **İşlem hash'i: yok.** TRY refresh, TTL extend, LP top-up ve pending kayıt silme yapılmadı.

1. Gerçek Anchor hatasının güvenli alanlarıyla nedenini doğrula; gerekiyorsa kullanıcı girdisinden ayrı dış tutar normalizasyonunu quote/status regresyonlarıyla tamamla. Ardından mevcut pending kaydı koruyarak Fund provasını yap.
2. Kullanıcının imzalaması için öneri: Stellar Testnet'te **1 USDC → EURC direct**, **1 EURC → rGBP two-hop**. İmza öncesi gerçek UI'da ağ, varlık, tutar ve aşağıdaki adresler tekrar doğrulanmalı; sonuç hash'leri ve alıcı bakiyesi zincirden teyit edilmeli. Aynı provada LP kayıt/deposit/withdraw ve fee envanteri kontrollerini kaydet.
   - Kodda tanımlı demo sender: `GBJTHJY5KZCMNDB3IFZHZRSILS7XFX6I6NCIDB4W6XD53CXPHUOXYXOC`
   - Önerilen recipient: `GB2MBGVLUFHBSMNCBMAOXCNQTP2UWSNL6YTWJ5X2MN4BITHAY4FB3RC4` — bu koşuda bir transferin doğrulanmış alıcısı değildir.
3. Sunum URL'sini bu commit ile eşleştir; gerçek wallet ve dar ekran provasını o URL'de tamamla.
4. Demo hemen öncesi preflight'ı tekrar çalıştır. TRY snapshot **2026-09-20 10:57 UTC**'de bitiyor; en erken ledger TTL yaklaşık **2026-09-26 09:35 UTC**. Demo zamanı gerektirirse ayrı onaylı `try:refresh`/TTL bakımı gerekli. Şu an likidite top-up zorunlu değil; büyük fon tutarı tek rotada gönderilemeyebilir.

`.env.local`, `.dev.vars`, `work/fx-secrets.json` yerelde mevcut, ignored ve untracked. Gerçek secret değerleri rapora/loglara alınmadı; commit edilen dosyalarda private-key/token örüntüsü bulunmadı.

## 20 Eylül 00:07–00:13 İstanbul — canlı prova hazırlığı

Başlangıç HEAD `6f269a9cb9a674311bd96fb3bdd036f12805960d`, çalışma ağacı temiz. `82d1f73` sonrasında ilgili kod değişmemiş: typecheck/lint/test/build/cargo tekrar çalıştırılmadı. Bu bölümün eklenmesi uygulama davranışını değiştirmiyor.

- **Gerçek tarayıcı:** mevcut Google Chrome 153.0.8010.50, normal (incognito olmayan) pencere; yeni açılan `http://localhost:3017/` sekmesi, mevcut PID 40389 sunucusu. Önceki headless test profili kullanılmadı. Chrome profil klasörünün adı macOS erişim kısıtı nedeniyle doğrulanamadı; buradan cüzdan eklentisinin eksik olduğu sonucu çıkarılmadı.
- **Somut engel:** Chrome hata 12: “JavaScript'i AppleScript üzerinden çalıştırma seçeneği kapalı.” Bu nedenle gerçek oturumun bağlı wallet/network ve local pending kayıtları henüz okunamadı. Hiçbir kayıt silinmedi, yeni deposit başlatılmadı, signer taklit edilmedi.
- **Şimdi gereken tek müdahale:** açılan Google Chrome penceresinde **Görünüm → Geliştirici → Apple Events'ten JavaScript'e izin ver** seçeneğini açıp haber ver. Sonrasında gerçek sayfanın Connect wallet akışı incelenecek; cüzdan kilidi ve imza kullanıcıda kalacak. Bu izin kendi başına cüzdan bağlantısı veya imza onayı değildir.
- **Güncel zincir okuması:** `npm run demo:preflight`, 19 Eylül 21:07 UTC / 20 Eylül 00:07 İstanbul: exit 0, 12 PASS / 1 TTL WARN / 0 FAIL; 1 ve 5 birim için 24/24 quote. Router aktif, Reflector fiyatları 139–140 sn yaşında. TRY bitişi zincirden tekrar **20 Eylül 13:57 İstanbul** olarak doğrulandı. Şu an bakım gerekmiyor; TRY/TTL/top-up yazımı yapılmadı.
- **Hesaplar:** yapılandırılmış aday sender `GBJT…YXOC` için USDC 3.4755, EURC 9.0359; aday recipient `GB2M…3RC4` için USDC 0.2910, EURC 1.9604. İki hesabın dört asset trustline'ı authorized. Bunlar tarayıcıda bağlı/incelemesi onaylanmış gerçek kullanıcı hesabı olarak henüz teyit edilmedi. Dört LP mevcut; aday sender zaten kayıtlı. Bu gözlem yeni LP browser kaydı veya o LP'nin rotada seçilmesi kanıtı değildir. Ayrı inventory/fee başlangıç görüntüsü kaydedildi; fee değişimi henüz ölçülmedi.
- **Video:** `outputs/demo-rehearsal-20260920/recording-trial-unsigned.mp4` gerçek, imzasız Send/Fund/Liquidity ekran kaydı; sahte success/hash yok. 96 kare yaklaşık 11.9 sn'de alındı, 12 sn MP4 üretildi; settlement süresi iddiası yok. Kayıt profili geçiciydi, auth kullanılmadı. macOS `CGPreflightScreenCaptureAccess=false`: gerçek Chrome ekran kaydı ayrıca engelli; bu video engeli canlı işlemleri durdurma gerekçesi değil. Başarılı gerçek kabul henüz olmadığı için 60–90 sn final video üretilmedi. Repo ve verilen bağlamda ayrı bir video brief dosyası bulunamadı; kullanıcıdaki Fund → receipt → Send/route → settlement → LP sırası esas alınacak.
- **Mevcut yayın:** `.openai/hosting.json` ile eşleşen Sites kaydı [Rise FX](https://rise-fx-stellar.cemilroyale10.chatgpt.site), sürüm 1. Salt-okunur erişim HTTP 401; bu adres güncel Veldora sunumu olarak kabul edilmedi. Yerel prova bundan bağımsız. Push/deploy yapılmadı.

Yeni kanıtlar `outputs/demo-rehearsal-20260920/` altında: `preflight.log`, yalnız public alanları içeren `public-baseline.json`, `access-check.json`, `recording-trial.json`, MP4 ve çözülmüş doğrulama kareleri. Üretilmiş dosyalar ignored. **Yeni browser-wallet PASS: yok. Yeni gerçek işlem/hash: yok. Demo hazır sonucu verilmedi.**
