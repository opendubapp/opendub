// The strings the dub card writes from JavaScript.
//
// The page itself is translated as whole documents (/zh-Hans, /ja, …), which is
// what a crawler reads and what the hreflang ring points at. These are the few
// sentences the card replaces as someone uses it — the button's own label, the
// status line while it looks for the app on this computer — so without them a
// translated card falls back to English the moment it is touched.
//
// English text is the key: a missing entry degrades to English rather than to
// an identifier on a button, which with eight catalogues is the failure that
// has to be survivable. `{name}` is interpolated.
//
// Everything the app shows *during* and *after* a dub — the stage log, the
// result labels — is still English; that is the next piece of work.

const CATALOGUE = {
  "zh-Hans": {
    "Look for the app on this computer": "在这台电脑上查找应用",
    "Enter your {provider} key above": "请在上方填写你的 {provider} 密钥",
    "Choose a video first": "请先选择视频",
    "Dub on this device": "在这台设备上配音",
    "This browser cannot encode video": "此浏览器无法编码视频",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "在网页中配音需要 Chrome、Edge 或 Safari 16.4 以上。",
    "{mb} MB — stays on this device": "{mb} MB — 不会离开这台设备",
    "Looking for the OpenDub app on this computer…": "正在查找这台电脑上的 OpenDub 应用…",
    "Connected to the OpenDub app on this computer.": "已连接到这台电脑上的 OpenDub 应用。",
    "The OpenDub app is running but OmniVoice is not installed: ": "OpenDub 应用已在运行，但尚未安装 OmniVoice：",
    "Start the OpenDub app on this computer (": "请在这台电脑上启动 OpenDub 应用（",
    "), then ": "），然后",
    "connect again": "重新连接",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "此浏览器不支持 WebGPU，人声分离将由 CPU 运行，可能很慢。首次会下载 172 MB 的分离模型。",
    "Higgs Audio API key": "Higgs Audio API 密钥",
    "ElevenLabs API key": "ElevenLabs API 密钥",
    "Used for this dub only and sent only to Boson AI. Never stored.": "只用于这次配音，只发给 Boson AI。绝不保存。",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "只用于这次配音，只发给 ElevenLabs。绝不保存。",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice 会说话，但不会翻译。不填 Higgs 密钥时，会在可用的地方改用 Chrome 内置的翻译器 —— 免费，而且就在这台设备上。",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs 没有翻译模型。不填 Higgs 密钥时，会在可用的地方改用 Chrome 内置的翻译器。",
    "Install it in one line": "一行命令装好",
    "Copy": "复制",
    "Copied": "已复制",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS 与 Linux。约 2 GB，几分钟。全部留在这台电脑上。",
    "When it finishes, press the button below.": "装好之后，点下面的按钮。",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "浏览器可能会请求访问本地网络的权限。那指的就是这台电脑上的这个应用，不是别的。",
    "Download OpenDub for Mac": "下载 Mac 版 OpenDub",
    "Download OpenDub for Windows": "下载 Windows 版 OpenDub",
    "Open it and press Install. No terminal, nothing to set up.": "打开后点「安装」。不用终端，也不用配置。",
    "Or install it with one line": "或者用一行命令装",
    "About 2 GB, a few minutes. It all stays on this computer.": "约 2 GB，几分钟。全部留在这台电脑上。",
    "Nothing answered on this computer.":
      "这台电脑上没有响应。",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "浏览器阻止了本页访问你的电脑。请在地址栏的图标里允许，然后再按一次。",
    "Downloading the translation pack… {pct}%": "正在下载翻译语言包… {pct}%",
  },
  "zh-Hant": {
    "Look for the app on this computer": "在這台電腦上尋找應用程式",
    "Enter your {provider} key above": "請在上方填入你的 {provider} 金鑰",
    "Choose a video first": "請先選擇影片",
    "Dub on this device": "在這台裝置上配音",
    "This browser cannot encode video": "此瀏覽器無法編碼影片",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "在網頁中配音需要 Chrome、Edge 或 Safari 16.4 以上。",
    "{mb} MB — stays on this device": "{mb} MB — 不會離開這台裝置",
    "Looking for the OpenDub app on this computer…": "正在尋找這台電腦上的 OpenDub 應用程式…",
    "Connected to the OpenDub app on this computer.": "已連線到這台電腦上的 OpenDub 應用程式。",
    "The OpenDub app is running but OmniVoice is not installed: ": "OpenDub 應用程式已在執行，但尚未安裝 OmniVoice：",
    "Start the OpenDub app on this computer (": "請在這台電腦上啟動 OpenDub 應用程式（",
    "), then ": "），然後",
    "connect again": "重新連線",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "此瀏覽器不支援 WebGPU，人聲分離會由 CPU 執行，可能很慢。首次會下載 172 MB 的分離模型。",
    "Higgs Audio API key": "Higgs Audio API 金鑰",
    "ElevenLabs API key": "ElevenLabs API 金鑰",
    "Used for this dub only and sent only to Boson AI. Never stored.": "只用於這次配音，也只送給 Boson AI。絕不儲存。",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "只用於這次配音，也只送給 ElevenLabs。絕不儲存。",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice 會說話，但不會翻譯。沒有 Higgs 金鑰時，會在可用的情況下改用 Chrome 內建的翻譯器 —— 免費，而且就在這台裝置上。",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs 沒有翻譯模型。沒有 Higgs 金鑰時，會在可用的情況下改用 Chrome 內建的翻譯器。",
    "Install it in one line": "一行指令裝好",
    "Copy": "複製",
    "Copied": "已複製",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS 與 Linux。約 2 GB，幾分鐘。全部留在這台電腦上。",
    "When it finishes, press the button below.": "裝好之後，點下面的按鈕。",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "瀏覽器可能會請求存取本機網路的權限。那指的就是這台電腦上的這個應用程式，不是別的。",
    "Download OpenDub for Mac": "下載 Mac 版 OpenDub",
    "Download OpenDub for Windows": "下載 Windows 版 OpenDub",
    "Open it and press Install. No terminal, nothing to set up.": "開啟後點「安裝」。不用終端機，也不用設定。",
    "Or install it with one line": "或者用一行指令裝",
    "About 2 GB, a few minutes. It all stays on this computer.": "約 2 GB，幾分鐘。全部留在這台電腦上。",
    "Nothing answered on this computer.":
      "這台電腦上沒有回應。",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "瀏覽器阻擋了本頁存取你的電腦。請在網址列的圖示中允許，然後再按一次。",
    "Downloading the translation pack… {pct}%": "正在下載翻譯語言包… {pct}%",
  },
  ja: {
    "Look for the app on this computer": "このパソコンでアプリを探す",
    "Enter your {provider} key above": "上に {provider} のキーを入力してください",
    "Choose a video first": "先に動画を選んでください",
    "Dub on this device": "この端末で吹き替える",
    "This browser cannot encode video": "このブラウザは動画を書き出せません",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "ここで吹き替えるには Chrome、Edge、または Safari 16.4 以降が必要です。",
    "{mb} MB — stays on this device": "{mb} MB — この端末から出ません",
    "Looking for the OpenDub app on this computer…": "このパソコンの OpenDub アプリを探しています…",
    "Connected to the OpenDub app on this computer.": "このパソコンの OpenDub アプリに接続しました。",
    "The OpenDub app is running but OmniVoice is not installed: ": "OpenDub アプリは動作していますが、OmniVoice が入っていません: ",
    "Start the OpenDub app on this computer (": "このパソコンで OpenDub アプリを起動し（",
    "), then ": "）、それから",
    "connect again": "再接続",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "このブラウザは WebGPU に対応していないため、音声の分離は CPU で実行され、時間がかかることがあります。初回に 172 MB の分離モデルを取得します。",
    "Higgs Audio API key": "Higgs Audio の API キー",
    "ElevenLabs API key": "ElevenLabs の API キー",
    "Used for this dub only and sent only to Boson AI. Never stored.": "この吹き替えにのみ使い、送信先は Boson AI だけです。保存はしません。",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "この吹き替えにのみ使い、送信先は ElevenLabs だけです。保存はしません。",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice は話しますが、翻訳はしません。Higgs のキーがない場合は、使える環境なら Chrome 内蔵の翻訳機能を使います — 無料で、この端末で。",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs には翻訳モデルがありません。Higgs のキーがない場合は、使える環境なら Chrome 内蔵の翻訳機能を使います。",
    "Install it in one line": "1 行で入れる",
    "Copy": "コピー",
    "Copied": "コピーしました",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS と Linux。約 2 GB、数分。このパソコンの外には何も出ません。",
    "When it finishes, press the button below.": "終わったら、下のボタンを押してください。",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "ブラウザがローカルネットワークへのアクセス許可を求めることがあります。これはこのパソコンの中のアプリのことで、それ以外ではありません。",
    "Download OpenDub for Mac": "Mac 版 OpenDub をダウンロード",
    "Download OpenDub for Windows": "Windows 版 OpenDub をダウンロード",
    "Open it and press Install. No terminal, nothing to set up.": "開いて「インストール」を押すだけ。ターミナルも設定も要りません。",
    "Or install it with one line": "1 行で入れることもできます",
    "About 2 GB, a few minutes. It all stays on this computer.": "約 2 GB、数分。すべてこのパソコンの中に留まります。",
    "Nothing answered on this computer.":
      "このパソコンからは応答がありませんでした。",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "ブラウザがこのページからパソコンへの接続をブロックしています。アドレスバーのアイコンから許可して、もう一度押してください。",
    "Downloading the translation pack… {pct}%": "翻訳パックをダウンロード中… {pct}%",
  },
  ko: {
    "Look for the app on this computer": "이 컴퓨터에서 앱 찾기",
    "Enter your {provider} key above": "위에 {provider} 키를 입력하세요",
    "Choose a video first": "먼저 영상을 선택하세요",
    "Dub on this device": "이 기기에서 더빙",
    "This browser cannot encode video": "이 브라우저는 영상을 인코딩할 수 없습니다",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "여기서 더빙하려면 Chrome, Edge 또는 Safari 16.4 이상이 필요합니다.",
    "{mb} MB — stays on this device": "{mb} MB — 이 기기를 벗어나지 않습니다",
    "Looking for the OpenDub app on this computer…": "이 컴퓨터의 OpenDub 앱을 찾는 중…",
    "Connected to the OpenDub app on this computer.": "이 컴퓨터의 OpenDub 앱에 연결되었습니다.",
    "The OpenDub app is running but OmniVoice is not installed: ": "OpenDub 앱은 실행 중이지만 OmniVoice가 설치되어 있지 않습니다: ",
    "Start the OpenDub app on this computer (": "이 컴퓨터에서 OpenDub 앱을 실행한 뒤(",
    "), then ": "), ",
    "connect again": "다시 연결",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "이 브라우저에는 WebGPU가 없어 음성 분리가 CPU에서 실행되며 오래 걸릴 수 있습니다. 172 MB 분리 모델을 한 번 내려받습니다.",
    "Higgs Audio API key": "Higgs Audio API 키",
    "ElevenLabs API key": "ElevenLabs API 키",
    "Used for this dub only and sent only to Boson AI. Never stored.": "이번 더빙에만 쓰이고 Boson AI에만 전송됩니다. 저장하지 않습니다.",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "이번 더빙에만 쓰이고 ElevenLabs에만 전송됩니다. 저장하지 않습니다.",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice는 말은 하지만 번역은 하지 않습니다. Higgs 키가 없으면 가능한 경우 Chrome 내장 번역기를 사용합니다 — 무료이고, 이 기기에서.",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs에는 번역 모델이 없습니다. Higgs 키가 없으면 가능한 경우 Chrome 내장 번역기를 사용합니다.",
    "Install it in one line": "한 줄로 설치",
    "Copy": "복사",
    "Copied": "복사됨",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS와 Linux. 약 2 GB, 몇 분. 이 컴퓨터를 벗어나는 것은 없습니다.",
    "When it finishes, press the button below.": "끝나면 아래 버튼을 누르세요.",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "브라우저가 로컬 네트워크 접근 권한을 물을 수 있습니다. 이는 이 컴퓨터 안의 앱을 뜻하며 다른 것은 아닙니다.",
    "Download OpenDub for Mac": "Mac용 OpenDub 내려받기",
    "Download OpenDub for Windows": "Windows용 OpenDub 내려받기",
    "Open it and press Install. No terminal, nothing to set up.": "열고 설치를 누르면 됩니다. 터미널도 설정도 필요 없습니다.",
    "Or install it with one line": "한 줄로 설치할 수도 있습니다",
    "About 2 GB, a few minutes. It all stays on this computer.": "약 2 GB, 몇 분. 모두 이 컴퓨터 안에 머무릅니다.",
    "Nothing answered on this computer.":
      "이 컴퓨터에서 응답이 없었습니다.",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "브라우저가 이 페이지의 컴퓨터 접근을 막고 있습니다. 주소창의 아이콘에서 허용한 뒤 다시 누르세요.",
    "Downloading the translation pack… {pct}%": "번역 팩 내려받는 중… {pct}%",
  },
  de: {
    "Look for the app on this computer": "Nach der App auf diesem Computer suchen",
    "Enter your {provider} key above": "Geben Sie oben Ihren {provider}-Schlüssel ein",
    "Choose a video first": "Wählen Sie zuerst ein Video",
    "Dub on this device": "Auf diesem Gerät synchronisieren",
    "This browser cannot encode video": "Dieser Browser kann kein Video erzeugen",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "Zum Synchronisieren hier brauchen Sie Chrome, Edge oder Safari 16.4+.",
    "{mb} MB — stays on this device": "{mb} MB — bleibt auf diesem Gerät",
    "Looking for the OpenDub app on this computer…": "Suche nach der OpenDub-App auf diesem Computer…",
    "Connected to the OpenDub app on this computer.": "Mit der OpenDub-App auf diesem Computer verbunden.",
    "The OpenDub app is running but OmniVoice is not installed: ": "Die OpenDub-App läuft, aber OmniVoice ist nicht installiert: ",
    "Start the OpenDub app on this computer (": "Starten Sie die OpenDub-App auf diesem Computer (",
    "), then ": "), dann ",
    "connect again": "erneut verbinden",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "Dieser Browser hat kein WebGPU, daher läuft das Entfernen der Stimme auf der CPU und kann lange dauern. Lädt einmalig ein 172 MB großes Trennmodell.",
    "Higgs Audio API key": "Higgs Audio API-Schlüssel",
    "ElevenLabs API key": "ElevenLabs API-Schlüssel",
    "Used for this dub only and sent only to Boson AI. Never stored.": "Nur für diese Synchronisation verwendet und nur an Boson AI gesendet. Wird nie gespeichert.",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "Nur für diese Synchronisation verwendet und nur an ElevenLabs gesendet. Wird nie gespeichert.",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice spricht, übersetzt aber nicht. Ohne Higgs-Schlüssel wird der in Chrome eingebaute Übersetzer verwendet, sofern verfügbar — kostenlos und auf diesem Gerät.",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs hat kein Übersetzungsmodell. Ohne Higgs-Schlüssel wird der in Chrome eingebaute Übersetzer verwendet, sofern verfügbar.",
    "Install it in one line": "In einer Zeile installieren",
    "Copy": "Kopieren",
    "Copied": "Kopiert",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS und Linux. Etwa 2 GB, ein paar Minuten. Nichts verlässt diesen Computer.",
    "When it finishes, press the button below.": "Wenn es fertig ist, drücken Sie die Schaltfläche unten.",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "Ihr Browser fragt möglicherweise nach Zugriff auf Ihr lokales Netzwerk. Gemeint ist diese App auf Ihrem Computer, nichts anderes.",
    "Download OpenDub for Mac": "OpenDub für Mac laden",
    "Download OpenDub for Windows": "OpenDub für Windows laden",
    "Open it and press Install. No terminal, nothing to set up.": "Öffnen und auf Installieren drücken. Kein Terminal, nichts einzurichten.",
    "Or install it with one line": "Oder mit einer Zeile installieren",
    "About 2 GB, a few minutes. It all stays on this computer.": "Etwa 2 GB, ein paar Minuten. Alles bleibt auf diesem Computer.",
    "Nothing answered on this computer.":
      "Auf diesem Computer hat nichts geantwortet.",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "Ihr Browser blockiert den Zugriff dieser Seite auf Ihren Computer. Erlauben Sie ihn über das Symbol in der Adressleiste und drücken Sie erneut.",
    "Downloading the translation pack… {pct}%": "Übersetzungspaket wird geladen… {pct} %",
  },
  es: {
    "Look for the app on this computer": "Buscar la app en este ordenador",
    "Enter your {provider} key above": "Escribe arriba tu clave de {provider}",
    "Choose a video first": "Elige primero un vídeo",
    "Dub on this device": "Doblar en este dispositivo",
    "This browser cannot encode video": "Este navegador no puede codificar vídeo",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "Para doblar aquí necesitas Chrome, Edge o Safari 16.4 o superior.",
    "{mb} MB — stays on this device": "{mb} MB: no sale de este dispositivo",
    "Looking for the OpenDub app on this computer…": "Buscando la app de OpenDub en este ordenador…",
    "Connected to the OpenDub app on this computer.": "Conectado a la app de OpenDub en este ordenador.",
    "The OpenDub app is running but OmniVoice is not installed: ": "La app de OpenDub está funcionando, pero OmniVoice no está instalado: ",
    "Start the OpenDub app on this computer (": "Inicia la app de OpenDub en este ordenador (",
    "), then ": ") y luego ",
    "connect again": "conecta de nuevo",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "Este navegador no tiene WebGPU, así que quitar la voz se ejecuta en la CPU y puede tardar mucho. Descarga una vez un separador de 172 MB.",
    "Higgs Audio API key": "Clave de API de Higgs Audio",
    "ElevenLabs API key": "Clave de API de ElevenLabs",
    "Used for this dub only and sent only to Boson AI. Never stored.": "Se usa solo para este doblaje y se envía solo a Boson AI. Nunca se guarda.",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "Se usa solo para este doblaje y se envía solo a ElevenLabs. Nunca se guarda.",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "OmniVoice habla, pero no traduce. Sin una clave de Higgs se usa el traductor integrado de Chrome cuando está disponible — gratis y en este dispositivo.",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "ElevenLabs no tiene modelo de traducción. Sin una clave de Higgs se usa el traductor integrado de Chrome cuando está disponible.",
    "Install it in one line": "Instálalo con una línea",
    "Copy": "Copiar",
    "Copied": "Copiado",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS y Linux. Unos 2 GB, unos minutos. Nada sale de este ordenador.",
    "When it finishes, press the button below.": "Cuando termine, pulsa el botón de abajo.",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "Puede que el navegador pida permiso para acceder a tu red local. Se refiere a esta app en tu ordenador, nada más.",
    "Download OpenDub for Mac": "Descargar OpenDub para Mac",
    "Download OpenDub for Windows": "Descargar OpenDub para Windows",
    "Open it and press Install. No terminal, nothing to set up.": "Ábrelo y pulsa Instalar. Sin terminal y sin configurar nada.",
    "Or install it with one line": "O instálalo con una línea",
    "About 2 GB, a few minutes. It all stays on this computer.": "Unos 2 GB, unos minutos. Todo se queda en este ordenador.",
    "Nothing answered on this computer.":
      "Nada respondió en este ordenador.",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "El navegador impide que esta página llegue a tu ordenador. Permítelo desde el icono de la barra de direcciones y vuelve a pulsar.",
    "Downloading the translation pack… {pct}%": "Descargando el paquete de traducción… {pct} %",
  },
  pt: {
    "Look for the app on this computer": "Procurar o aplicativo neste computador",
    "Enter your {provider} key above": "Digite acima a sua chave da {provider}",
    "Choose a video first": "Escolha um vídeo primeiro",
    "Dub on this device": "Dublar neste dispositivo",
    "This browser cannot encode video": "Este navegador não consegue codificar vídeo",
    "Dubbing here needs Chrome, Edge or Safari 16.4+.": "Para dublar aqui é preciso Chrome, Edge ou Safari 16.4 ou superior.",
    "{mb} MB — stays on this device": "{mb} MB — não sai deste dispositivo",
    "Looking for the OpenDub app on this computer…": "Procurando o aplicativo OpenDub neste computador…",
    "Connected to the OpenDub app on this computer.": "Conectado ao aplicativo OpenDub neste computador.",
    "The OpenDub app is running but OmniVoice is not installed: ": "O aplicativo OpenDub está rodando, mas o OmniVoice não está instalado: ",
    "Start the OpenDub app on this computer (": "Inicie o aplicativo OpenDub neste computador (",
    "), then ": ") e depois ",
    "connect again": "conecte novamente",
    "This browser has no WebGPU, so removing the voice runs on the CPU and can take a long time. Downloads a 172 MB separator once.":
      "Este navegador não tem WebGPU, então remover a voz roda na CPU e pode demorar muito. Baixa uma vez um separador de 172 MB.",
    "Higgs Audio API key": "Chave de API do Higgs Audio",
    "ElevenLabs API key": "Chave de API da ElevenLabs",
    "Used for this dub only and sent only to Boson AI. Never stored.": "Usada só nesta dublagem e enviada só para a Boson AI. Nunca é armazenada.",
    "Used for this dub only and sent only to ElevenLabs. Never stored.": "Usada só nesta dublagem e enviada só para a ElevenLabs. Nunca é armazenada.",
    "OmniVoice speaks but does not translate. Without a Higgs key, Chrome's built-in translator is used where available — free, and on this device.":
      "O OmniVoice fala, mas não traduz. Sem uma chave Higgs, usamos o tradutor embutido do Chrome onde ele existir — grátis e neste dispositivo.",
    "ElevenLabs has no translation model. Without a Higgs key, Chrome's built-in translator is used where available.":
      "A ElevenLabs não tem modelo de tradução. Sem uma chave Higgs, usamos o tradutor embutido do Chrome onde ele existir.",
    "Install it in one line": "Instale com uma linha",
    "Copy": "Copiar",
    "Copied": "Copiado",
    "macOS and Linux. About 2 GB, a few minutes. Nothing leaves this computer.": "macOS e Linux. Cerca de 2 GB, alguns minutos. Nada sai deste computador.",
    "When it finishes, press the button below.": "Quando terminar, clique no botão abaixo.",
    "Your browser may ask to allow access to your local network. That is this app on your computer — nothing else.":
      "O navegador pode pedir permissão para acessar sua rede local. Trata-se deste aplicativo no seu computador, nada mais.",
    "Download OpenDub for Mac": "Baixar o OpenDub para Mac",
    "Download OpenDub for Windows": "Baixar o OpenDub para Windows",
    "Open it and press Install. No terminal, nothing to set up.": "Abra e clique em Instalar. Sem terminal, nada para configurar.",
    "Or install it with one line": "Ou instale com uma linha",
    "About 2 GB, a few minutes. It all stays on this computer.": "Cerca de 2 GB, alguns minutos. Tudo fica neste computador.",
    "Nothing answered on this computer.":
      "Nada respondeu neste computador.",
    "Your browser is blocking this page from reaching your computer. Allow it from the icon in the address bar, then press again.":
      "O navegador está impedindo esta página de acessar seu computador. Permita pelo ícone na barra de endereços e clique de novo.",
    "Downloading the translation pack… {pct}%": "Baixando o pacote de tradução… {pct}%",
  },
};

/** The page's own language decides the catalogue; each locale is a whole page. */
const LOCALE = (() => {
  // `typeof` guard: a check that imports this file outside a browser (no `document`)
  // must still load it, otherwise the catalogues can only be inspected by hand.
  const tag = (typeof document === "undefined" ? "en" : document.documentElement.lang || "en").toLowerCase();
  if (tag.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(tag) ? "zh-Hant" : "zh-Hans";
  return ["ja", "ko", "de", "es", "pt"].find((l) => tag.startsWith(l)) || "en";
})();

/** English text is the key, so a missing entry shows English rather than an id. */
export function t(text, vars) {
  let out = CATALOGUE[LOCALE]?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

export const locale = LOCALE;
