/**
 * Wizard language. The setup / undo / uninstall wizards speak the user's language when a translation exists
 * (today: Turkish). Detection: MYCEL_LANG, then LC_ALL / LC_MESSAGES / LANG, then the system locale.
 * Translation works on finished lines, so the wizard code stays in English and tests see English.
 */
export type Lang = "en" | "tr";

export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const pick = (v?: string) => (v && /^tr([_.-]|$)/i.test(v) ? "tr" : v && /^[a-z]{2}/i.test(v) && v !== "C" && v !== "POSIX" ? "en" : null);
  const forced = env.MYCEL_LANG?.toLowerCase();
  if (forced === "tr" || forced === "en") return forced;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const l = pick(v);
    if (l === "tr") return "tr";
  }
  try {
    if (/^tr\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) return "tr";
  } catch {
    /* no Intl */
  }
  return "en";
}

type Rule = [RegExp, string];
// Order matters: the first matching rule wins for each pattern, and all rules are applied in turn.
const TR: Rule[] = [
  [/\[Y\/n\] $/, "[E/h] "],
  [/\[y\/N\] $/, "[e/H] "],
  [/^(\s*)No MCP client configs with servers were found \(looked for (.*)\)\.$/, "$1Sunucu içeren bir MCP uygulama ayarı bulunamadı (bakılanlar: $2)."],
  [/^(\s*)Nothing changed\. Add servers to your client first, or write (.*) by hand \(see mycel init\)\.$/, "$1Hiçbir şey değişmedi. Önce uygulamanıza sunucu ekleyin ya da $2 dosyasını elle yazın (bkz. mycel init)."],
  [/^(\s*)(.+) file (.+) \((\d+) server\(s\)\) is shared with your team\. Include it too\? /, "$1$2 dosyası $3 ($4 sunucu) ekibinizle paylaşılıyor. Bunu da ekleyeyim mi? "],
  [/project file shared with your team; left alone \(add --projects to include it\)/, "ekiple paylaşılan proje dosyası; dokunulmadı (eklemek için --projects)"],
  [/ skipped: /, " atlandı: "],
  [/^(\s*)Nothing to do\.$/, "$1Yapılacak bir şey yok."],
  [/^(\s*)Found:$/, "$1Bulunanlar:"],
  [/^(\s*)What will change:$/, "$1Neler değişecek:"],
  [/ (\d+) servers  /, " $1 sunucu   "],
  [/ (\d+) server   /, " $1 sunucu   "],
  [/add (\d+) server\(s\) to existing (.+) \(existing entries untouched\)/, "mevcut $2 dosyasına $1 sunucu ekle (var olan kayıtlara dokunulmaz)"],
  [/(.+) already has these servers; unchanged/, "$1 bu sunuculara zaten sahip; değişmeyecek"],
  [/create (.+) with (\d+) server\(s\)/, "$2 sunucuyla $1 oluştur"],
  [/note: "(.+)" already exists in (.+); kept the existing definition/, "not: \"$1\" zaten $2 içinde var; mevcut tanım korundu"],
  [/already points at Mycel; nothing to change/, "zaten Mycel'e bağlı; değişiklik yok"],
  [/Claude Desktop extensions: run (.+) through Mycel and turn them off in Claude Desktop/, "Claude Desktop eklentileri: $1 Mycel üzerinden çalışacak ve Claude Desktop'ta kapatılacak"],
  [/ \(adds a "mycel" entry to (.+)\)/, " ($1 dosyasına bir \"mycel\" kaydı eklenir)"],
  [/extension left as is: /, "dokunulmayan eklenti: "],
  [/Claude Code plugins bring (\d+) server\(s\) of their own \((.+)\); plugins manage them, so they stay as they are/, "Claude Code eklentilerinin kendi $1 sunucusu var ($2); bunları eklentiler yönetiyor, olduğu gibi kalacaklar"],
  [/clients will start Mycel with: /, "uygulamalar Mycel'i şununla başlatacak: "],
  [/move (\d+) API key\(s\) out of client configs into (.+) \(only you can read them; you don't need to set anything\)/, "$1 API anahtarı uygulama ayarlarından çıkarılıp $2 içine taşınacak (yalnızca siz okuyabilirsiniz; hiçbir şey ayarlamanız gerekmez)"],
  [/the macOS Keychain/, "macOS Anahtar Zinciri"],
  [/your system keyring/, "sistem anahtarlığı"],
  [/(\d+) API key\(s\) have no value yet \((.+)\); you can paste them in a moment/, "$1 API anahtarının değeri yok ($2); birazdan yapıştırabilirsiniz"],
  [/^(\s*)Skipped: /, "$1Atlananlar: "],
  [/Backups of every changed file go to (.+) \(undo any time with: mycel undo\)/, "Değişen her dosyanın yedeği $1 klasörüne alınır (istediğiniz zaman geri alın: mycel undo)"],
  [/Everything already points at Mycel\. Nothing to do\./, "Her şey zaten Mycel'e bağlı. Yapılacak bir şey yok."],
  [/Dry run: nothing was changed \(no terminal to ask in\)\. Run again with --yes to apply:/, "Deneme: hiçbir şey değişmedi (soru soracak terminal yok). Uygulamak için --yes ile tekrar çalıştırın:"],
  [/Apply these changes\? /, "Bu değişiklikleri uygulayayım mı? "],
  [/Cancelled\. Nothing changed\./, "İptal edildi. Hiçbir şey değişmedi."],
  [/^(\s*)(\w+): paste the value \(hidden; Enter to skip\): $/, "$1$2: değeri yapıştırın (görünmez; atlamak için Enter): "],
  [/skipped; add later as a line (\w+)=… in (.+)$/, "atlandı; sonra $2 dosyasına $1=… satırı olarak ekleyebilirsiniz"],
  [/Show what Mycel saves \(tokens, %, ≈ \$ and time\) at the end of each answer\? /, "Mycel'in kazandırdığını (token, %, yaklaşık $ ve süre) her cevabın sonunda göstereyim mi? "],
  [/✓ extension (.+): now runs through Mycel/, "✓ $1 eklentisi artık Mycel üzerinden çalışıyor"],
  [/✓ (\d+) API key\(s\): /, "✓ $1 API anahtarı: "],
  [/Done\. Restart (.+)\. See your savings anytime: mycel stats  ·  Undo: mycel undo/, "Tamam. $1 uygulamasını yeniden başlatın. Kazancınızı istediğiniz an görün: mycel stats  ·  Geri al: mycel undo"],
  [/Mycel is set up: (\d+) of (\d+) server\(s\) working, (\d+) tools\./, "Mycel kuruldu: $2 sunucudan $1 tanesi çalışıyor, $3 araç."],
  [/Tool definitions: (.+) tokens \(−(\d+)%, estimated; applies when an app sends every tool definition each turn\)\./, "Araç tanımları: $1 token (−%$2, tahmini; bir uygulama her turda tüm araç tanımlarını gönderiyorsa geçerli)."],
  [/Your savings show up at the end of answers, and any time with: mycel stats/, "Kazancınız cevapların sonunda görünür; istediğiniz an: mycel stats"],
  [/Not working yet: (.+)\. Check later with: mycel doctor/, "Henüz çalışmayanlar: $1. Sonra kontrol edin: mycel doctor"],
  [/Changed your mind\? mycel undo/, "Vazgeçtiniz mi? mycel undo"],
  [/Checking each server through Mycel…/, "Her sunucu Mycel üzerinden kontrol ediliyor…"],
  [/✗ the Mycel config could not be read: /, "✗ Mycel ayarı okunamadı: "],
  [/: (\d+) tools$/, ": $1 araç"],
  [/! (.+): needs a one-time sign-in\. Run: mycel login (.+)$/, "! $1: bir kez giriş yapılması gerekiyor. Çalıştırın: mycel login $2"],
  [/(.+) needs a one-time sign-in\. Open your browser now\? /, "$1 için bir kez giriş yapmak gerekiyor. Tarayıcıyı şimdi açayım mı? "],
  [/later: mycel login /, "sonra: mycel login "],
  [/: signed in, (\d+) tools$/, ": giriş yapıldı, $1 araç"],
  [/: sign-in did not finish \((.+)\)\. Try again later: mycel login (.+)$/, ": giriş tamamlanmadı ($1). Sonra tekrar deneyin: mycel login $2"],
  [/ — add (\w+)=… to the secrets file/, " — gizli dosyaya $1=… ekleyin"],
  [/Claude Code: start a new session \(or type \/mcp\) to load Mycel/, "Claude Code: Mycel'in yüklenmesi için yeni bir oturum açın (ya da /mcp yazın)"],
  [/Gemini CLI: start it again/, "Gemini CLI: yeniden başlatın"],
  [/: setup is running inside it, so quit and reopen it when this finishes/, ": kurulum bu uygulamanın içinde çalışıyor; bitince kapatıp yeniden açın"],
  [/: quit and reopen it \(automatic restart did not work\)/, ": kapatıp yeniden açın (otomatik yeniden başlatma olmadı)"],
  [/: quit and reopen it/, ": kapatıp yeniden açın"],
  [/: restart it$/, ": yeniden başlatın"],
  [/✓ (.+) is closed; it will load Mycel when you open it/, "✓ $1 kapalı; açtığınızda Mycel'i yükleyecek"],
  [/Restart (.+) now so it loads Mycel\? Open chats are kept\. /, "$1 şimdi yeniden başlatılsın mı (Mycel'i yüklemesi için)? Açık sohbetler korunur. "],
  [/✓ (.+) restarted/, "✓ $1 yeniden başlatıldı"],
  [/To finish:/, "Bitirmek için:"],
  [/No setup backups\./, "Kurulum yedeği yok."],
  [/changed since setup: (.+)\.$/, "kurulumdan sonra değişti: $1."],
  [/Overwrite it with the backup\? /, "Yedekle üzerine yazayım mı? "],
  [/backup file is missing, left as is/, "yedek dosyası yok, olduğu gibi bırakıldı"],
  [/kept your newer version \(use --yes to force\)/, "sizin yeni sürümünüz korundu (zorlamak için --yes)"],
  [/removed the "mycel" entry setup added to /, "kurulumun eklediği \"mycel\" kaydı kaldırıldı: "],
  [/ could not be read; left as is/, " okunamadı; olduğu gibi bırakıldı"],
  [/Secrets file (.+) was created by setup and holds your API keys; kept \(your restored client configs have them again; delete it if you stop using Mycel\)/, "$1 gizli dosyasını kurulum oluşturdu ve API anahtarlarınızı içeriyor; korundu (geri yüklenen uygulama ayarlarında anahtarlar yine var; Mycel'i bırakırsanız silebilirsiniz)"],
  [/Mycel config (.+) was created by setup; kept \(delete it yourself if unwanted\)/, "$1 Mycel ayarını kurulum oluşturdu; korundu (istemezseniz silebilirsiniz)"],
  [/✓ restored /, "✓ geri yüklendi: "],
  [/Restored (\d+) file\(s\)\. Restart your clients\./, "$1 dosya geri yüklendi. Uygulamalarınızı yeniden başlatın."],
  [/restore your apps from (\d+) setup backup\(s\)( \(none found\))?/, "uygulamalarınızı $1 kurulum yedeğinden geri yükle"],
  [/remove the mycel PATH line from /, "mycel PATH satırını şuradan kaldır: "],
  [/remove Mycel's API keys from the system keychain/, "Mycel'in API anahtarlarını sistem anahtar zincirinden kaldır"],
  [/delete (.+) \(config, API keys, logs, backups, the private Node\.js and Mycel copy\)/, "$1 klasörünü sil (ayar, API anahtarları, kayıtlar, yedekler, özel Node.js ve Mycel kopyası)"],
  [/Dry run: nothing was changed\. Run again with --yes to uninstall\./, "Deneme: hiçbir şey değişmedi. Kaldırmak için --yes ile tekrar çalıştırın."],
  [/Uninstall Mycel\? /, "Mycel kaldırılsın mı? "],
  [/✓ apps restored to their settings from before Mycel/, "✓ uygulamalar Mycel öncesi ayarlarına döndü"],
  [/: PATH line removed/, ": PATH satırı kaldırıldı"],
  [/✓ (\d+) key\(s\) removed from the keychain/, "✓ $1 anahtar anahtar zincirinden kaldırıldı"],
  [/✓ (.+) deleted$/, "✓ $1 silindi"],
  [/Mycel is uninstalled\. Restart your apps\. Thanks for trying it\./, "Mycel kaldırıldı. Uygulamalarınızı yeniden başlatın. Denediğiniz için teşekkürler."],
];

/** Translate one finished line (or prompt) of wizard output. Unknown text passes through unchanged. */
export function translate(line: string, lang: Lang): string {
  if (lang !== "tr") return line;
  let s = line;
  for (const [re, rep] of TR) if (typeof rep === "string") s = s.replace(re, rep);
  // "replace N servers in "key" with one "mycel" entry" (kept apart because of the optional tail)
  s = s.replace(/replace (\d+) servers? in "(.+?)" with one "mycel" entry(?: and empty (\d+) per-project server list\(s\))?/, (_m, n: string, k: string, p?: string) => `"${k}" içindeki ${n} sunucuyu tek bir "mycel" kaydıyla değiştir${p ? ` ve ${p} proje sunucu listesini boşalt` : ""}`);
  return s;
}
