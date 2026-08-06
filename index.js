const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const puppeteer = require("puppeteer");

const DOTNET_PROJECT =
    "C:\\Programacion\\hx-midi-dotnet\\hx-midi-dotnet.csproj";

const YOUTUBE_HOME = "https://www.youtube.com/";
const PROFILE_DIRECTORY = ".youtube-chrome-profile";

/*
 * Uso:
 *
 *   node youtube-video-midi.js
 *   node youtube-video-midi.js "https://www.youtube.com/watch?v=..."
 *   node youtube-video-midi.js "https://youtu.be/..." 1:35 2:50
 *   node youtube-video-midi.js 1:35 2:50
 *
 * Si el primer argumento es una URL de YouTube, se abre esa URL.
 * Los siguientes argumentos son marcadores opcionales. También se
 * puede omitir la URL y pasar directamente los dos marcadores.
 *
 * Los tiempos aceptan segundos, mm:ss o hh:mm:ss.
 *
 * Mapeo MIDI:
 *
 * CC 7  → volumen continuo (valor MIDI 0-127)
 * CC 100 → pedal de expresión / velocidad 0-100%
 * CC 80 → inicio
 * CC 81 → marcador 1 (por defecto 1:35)
 * CC 82 → marcador 2 (por defecto 2:50)
 * CC 83 → play / pausa
 * CC 84 → retroceder 5 segundos
 * CC 85 → avanzar 5 segundos
 * CC 86 → mute / unmute
 * CC 87 → alternar velocidad 0.5x / 0.75x / 1x / 1.25x / 1.5x / 2x
 * CC 88 → activar / desactivar subtítulos
 * CC 89 → activar / desactivar pantalla completa
 * CC 90 → siguiente video
 * CC 91 → video anterior (cuando existe, por ejemplo en una playlist)
 * CC 99 → play / pausa (alias)
 */

const cli = parseCliArguments(process.argv.slice(2));

const markers = new Map([
    [80, 0],
    [81, cli.marker1],
    [82, cli.marker2]
]);

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const lastControllerPress = new Map();

const MIDI_DEBOUNCE_MS = 150;
const VOLUME_CONTROLLER = 7;
const EXPRESSION_CONTROLLER = 100;
const MIDI_VALUE_MAX = 127;
const EXPRESSION_VALUE_MAX = 100;
const MIN_PLAYBACK_RATE = 0.25;
const EXPRESSION_THROTTLE_MS = 80;

let browser = null;
let midiProcess = null;
let shuttingDown = false;

let rememberedYouTubeState = defaultYouTubeState();
let pendingExpressionValue = null;
let expressionUpdateInFlight = false;
let expressionUpdateTimeout = null;
let lastExpressionUpdateAt = 0;

async function main() {
    browser = await launchYouTubeBrowser();

    browser.on("targetcreated", async target => {
        if (target.type() !== "page") {
            return;
        }

        try {
            await prepareYouTubePage(
                await target.page()
            );
        } catch {
            // No es crítico: puede ser una pestaña interna de Chrome.
        }
    });

    const page = await getOrCreateYouTubePage(
        cli.initialUrl
    );

    await page.bringToFront();

    startMidiListener();

    console.log("");
    console.log(
        "Controlador MIDI para YouTube iniciado."
    );

    console.log(
        `URL inicial: ${cli.initialUrl}`
    );

    console.log(
        `Marcadores: CC 81 = ${formatTime(cli.marker1)}, ` +
        `CC 82 = ${formatTime(cli.marker2)}`
    );

    console.log(
        "Abrí o reproducí un video en la ventana controlada."
    );

    console.log(
        "Presioná Ctrl+C para finalizar."
    );
}

async function launchYouTubeBrowser() {
    const launchOptions = {
        headless: false,

        /*
         * Usa un perfil independiente del Chrome normal.
         * Conserva sesión, cookies y configuración de YouTube.
         */
        userDataDir: path.resolve(
            __dirname,
            PROFILE_DIRECTORY
        ),

        defaultViewport: null,

        ignoreDefaultArgs: [
            "--enable-automation"
        ],

        args: [
            "--start-maximized",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--no-default-browser-check",
            "--no-first-run",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=CalculateNativeWinOcclusion",

            /*
             * Facilita la reproducción iniciada mediante MIDI.
             */
            "--autoplay-policy=no-user-gesture-required"
        ]
    };

    try {
        return await puppeteer.launch({
            ...launchOptions,
            channel: "chrome"
        });
    } catch (error) {
        console.warn(
            "[Chrome] No se pudo usar Google Chrome instalado. " +
            "Probando con el navegador de Puppeteer:",
            error.message
        );

        return puppeteer.launch(launchOptions);
    }
}

async function prepareYouTubePage(page) {
    if (!page) {
        return;
    }

    const hideWebDriver = () => {
        Object.defineProperty(
            navigator,
            "webdriver",
            {
                get: () => false
            }
        );
    };

    await page.evaluateOnNewDocument(hideWebDriver);

    try {
        await page.evaluate(hideWebDriver);
    } catch {
        // La página puede estar navegando o ser about:blank.
    }
}

async function getOrCreateYouTubePage(initialUrl) {
    const pages = await browser.pages();

    await Promise.all(
        pages.map(page => prepareYouTubePage(page))
    );

    const existingPage = pages.find(
        page => isYouTubeUrl(page.url())
    );

    if (existingPage) {
        if (
            initialUrl !== YOUTUBE_HOME &&
            existingPage.url() !== initialUrl
        ) {
            await existingPage.goto(initialUrl, {
                waitUntil: "domcontentloaded"
            });
        }

        return existingPage;
    }

    const blankPage = pages.find(
        page => page.url() === "about:blank"
    );

    const page =
        blankPage ?? await browser.newPage();

    await page.goto(initialUrl, {
        waitUntil: "domcontentloaded"
    });

    return page;
}

function startMidiListener() {
    midiProcess = spawn(
        "dotnet",
        [
            "run",
            "--project",
            DOTNET_PROJECT,
            "--no-build"
        ],
        {
            windowsHide: true,
            stdio: [
                "ignore",
                "pipe",
                "pipe"
            ]
        }
    );

    const output = readline.createInterface({
        input: midiProcess.stdout,
        crlfDelay: Infinity
    });

    output.on("line", line => {
        let midiEvent;

        try {
            midiEvent = JSON.parse(line);
        } catch {
            console.log("[.NET]", line);
            return;
        }

        handleMidiEvent(midiEvent).catch(error => {
            console.error(
                "[MIDI action error]",
                error.message
            );
        });
    });

    midiProcess.stderr.on("data", data => {
        console.error(
            "[.NET error]",
            data.toString().trim()
        );
    });

    midiProcess.on("error", error => {
        console.error(
            "No se pudo iniciar el listener MIDI de .NET:",
            error.message
        );
    });

    midiProcess.on("exit", code => {
        if (!shuttingDown) {
            console.log(
                `El listener MIDI terminó con código ${code}.`
            );
        }
    });
}

async function handleMidiEvent(event) {
    if (event.type === "devices") {
        console.log(
            `[MIDI] ${event.count} entradas detectadas.`
        );

        return;
    }

    if (event.type === "opening") {
        console.log(
            `[MIDI] Abriendo ${event.endpointName}...`
        );

        return;
    }

    if (event.type === "ready") {
        console.log(
            `[MIDI] Escuchando ${event.endpointName}.`
        );

        return;
    }

    if (event.type === "error") {
        console.error(
            "[MIDI listener]",
            event.message
        );

        return;
    }

    if (event.type !== "controlChange") {
        console.log("[MIDI]", event);
        return;
    }

    console.log(
        `[MIDI] Canal ${event.channel}, ` +
        `CC ${event.controller}, ` +
        `valor ${event.value}`
    );

    /*
     * El volumen y el pedal de expresión son controles continuos.
     *
     * A diferencia de los footswitches, también debe
     * aceptar el valor 0 y no aplica debounce.
     */
    if (event.controller === VOLUME_CONTROLLER) {
        await setYouTubeVolume(
            event.value,
            MIDI_VALUE_MAX
        );

        return;
    }

    if (event.controller === EXPRESSION_CONTROLLER) {
        scheduleYouTubePlaybackRatePercent(event.value);

        return;
    }

    /*
     * Ignoramos la liberación del footswitch.
     */
    if (event.value === 0) {
        return;
    }

    /*
     * Evita dobles pulsaciones accidentales.
     */
    if (isRepeatedPress(event.controller)) {
        return;
    }

    if (markers.has(event.controller)) {
        const result =
            await seekYouTubeVideo(
                markers.get(event.controller),
                true
            );

        console.log(
            `[YouTube] Posición: ` +
            `${formatTime(result.currentTime)} ` +
            `/ ${formatTime(result.duration)}`
        );

        return;
    }

    switch (event.controller) {
        
        case 80:
            await changeYouTubePosition(0);
            break;
        
        case 81:
            await changeYouTubePosition(process.argv[2] || 0);
            break;

        case 82:
            await changeYouTubePosition(process.argv[3] || 0);
            break;

        case 83:
            await changeYouTubePosition(process.argv[4] || 0);
            break;

        case 84:
            await deathRefreshYouTube();
            break;


        case 99:
        await toggleYouTubePlayback();
        break;
        
        default:
            console.log(
                `[MIDI] CC ${event.controller} sin acción.`
            );

            break;
    }
}

async function deathRefreshYouTube() {
    let page = await findYouTubePage();

    const originalUrl = page.url();

    let savedState = {
        ...rememberedYouTubeState
    };

    /*
     * Intentamos guardar el estado actual.
     * Si el renderer de YouTube está totalmente colgado,
     * page.evaluate() puede fallar y seguimos con los
     * últimos valores recordados por el proceso Node.
     */
    try {
        savedState = rememberYouTubeState(
            await page.evaluate(() => {
                const video =
                    document.querySelector(
                        "video.html5-main-video"
                    ) ??
                    document.querySelector("video");

                if (!video) {
                    return null;
                }

                return {
                    currentTime:
                        Number.isFinite(video.currentTime)
                            ? video.currentTime
                            : 0,

                    paused: video.paused,
                    muted: video.muted,
                    volume: video.volume,
                    playbackRate: video.playbackRate
                };
            })
        );
    } catch (error) {
        console.warn(
            "[YouTube] No se pudo leer el estado actual. " +
            "Usando el último estado recordado:",
            error.message
        );
    }

    console.log(
        `[YouTube] Refresh de la muerte en ` +
        `${formatTime(savedState.currentTime)}...`
    );

    let reloadSucceeded = false;

    /*
     * Primer nivel: recarga normal, pero sin reutilizar
     * la caché actual.
     */
    try {
        await page.setCacheEnabled(false);

        await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 15_000
        });

        reloadSucceeded = true;
    } catch (error) {
        console.warn(
            "[YouTube] page.reload() falló:",
            error.message
        );
    }

    /*
     * Segundo nivel: navegar nuevamente a la URL.
     *
     * Esto suele resolver estados rotos causados por la
     * navegación SPA de YouTube.
     */
    if (!reloadSucceeded) {
        try {
            await page.goto(originalUrl, {
                waitUntil: "domcontentloaded",
                timeout: 20_000
            });

            reloadSucceeded = true;
        } catch (error) {
            console.warn(
                "[YouTube] page.goto() falló:",
                error.message
            );
        }
    }

    /*
     * Tercer nivel: sacrificar completamente la pestaña.
     *
     * Creamos otra pestaña, navegamos a la misma URL y
     * cerramos la pestaña anterior.
     */
    if (!reloadSucceeded) {
        console.warn(
            "[YouTube] La pestaña no responde. " +
            "Creando una nueva..."
        );

        const deadPage = page;

        page = await browser.newPage();

        await page.goto(originalUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000
        });

        try {
            await deadPage.close();
        } catch {
            /*
             * La pestaña puede estar tan colgada que
             * incluso cerrarla produzca un error.
             */
        }
    }

    try {
        await page.setCacheEnabled(true);
    } catch {
        // No es crítico.
    }

    await page.bringToFront();

    /*
     * Esperamos a que YouTube vuelva a crear el elemento
     * principal de video.
     */
    await page.waitForSelector(
        "video.html5-main-video, video",
        {
            timeout: 20_000
        }
    );

    /*
     * Restauramos el estado previo.
     */
    const restoredState = await page.evaluate(
        async savedState => {
            const video =
                document.querySelector(
                    "video.html5-main-video"
                ) ??
                document.querySelector("video");

            if (!video) {
                throw new Error(
                    "YouTube recargó, pero no apareció " +
                    "ningún elemento <video>."
                );
            }

            if (
                video.readyState <
                HTMLMediaElement.HAVE_METADATA
            ) {
                await new Promise(
                    (resolve, reject) => {
                        const timeout = setTimeout(
                            () => reject(
                                new Error(
                                    "Timeout esperando los " +
                                    "metadatos después del refresh."
                                )
                            ),
                            15_000
                        );

                        video.addEventListener(
                            "loadedmetadata",
                            () => {
                                clearTimeout(timeout);
                                resolve();
                            },
                            { once: true }
                        );

                        video.addEventListener(
                            "error",
                            () => {
                                clearTimeout(timeout);

                                reject(
                                    new Error(
                                        "El video produjo un error " +
                                        "después del refresh."
                                    )
                                );
                            },
                            { once: true }
                        );
                    }
                );
            }

            video.volume = Math.min(
                Math.max(savedState.volume, 0),
                1
            );

            video.muted = savedState.muted;

            video.defaultPlaybackRate =
                savedState.playbackRate;

            video.playbackRate =
                savedState.playbackRate;

            if (
                Number.isFinite(savedState.currentTime) &&
                savedState.currentTime > 0
            ) {
                const maximum =
                    Number.isFinite(video.duration)
                        ? Math.max(
                            0,
                            video.duration - 0.25
                        )
                        : savedState.currentTime;

                video.currentTime = Math.min(
                    savedState.currentTime,
                    maximum
                );
            }

            /*
             * Dejamos que YouTube procese el seek antes
             * de intentar reproducir.
             */
            await new Promise(resolve =>
                setTimeout(resolve, 300)
            );

            if (!savedState.paused) {
                await video.play();
            }

            return {
                currentTime: video.currentTime,
                paused: video.paused,
                muted: video.muted,
                volume: video.volume,
                playbackRate: video.playbackRate
            };
        },
        savedState
    );

    rememberYouTubeState(restoredState);

    console.log(
        `[YouTube] Refresh completado. ` +
        `Posición ${formatTime(restoredState.currentTime)}, ` +
        `${restoredState.paused ? "pausado" : "reproduciendo"}, ` +
        `${restoredState.playbackRate}x.`
    );

    return restoredState;
}

function defaultYouTubeState() {
    return {
        currentTime: 0,
        paused: true,
        muted: false,
        volume: 1,
        playbackRate: 1
    };
}

function rememberYouTubeState(state) {
    if (!state) {
        return rememberedYouTubeState;
    }

    rememberedYouTubeState = {
        ...rememberedYouTubeState,
        ...state
    };

    return rememberedYouTubeState;
}

function isRepeatedPress(controller) {
    const now = Date.now();

    const previous =
        lastControllerPress.get(controller) ?? 0;

    lastControllerPress.set(
        controller,
        now
    );

    return (
        now - previous <
        MIDI_DEBOUNCE_MS
    );
}

async function findYouTubePage() {
    const pages = await browser.pages();

    const youtubePages = pages.filter(
        page => isYouTubeUrl(page.url())
    );

    if (youtubePages.length === 0) {
        throw new Error(
            "No hay ninguna pestaña de YouTube abierta."
        );
    }

    let selectedPage = youtubePages[0];
    let highestScore = -1;

    /*
     * Si hay más de una pestaña de YouTube, prioriza:
     *
     * 1. La que esté reproduciendo.
     * 2. La que tenga el video principal de YouTube.
     * 3. La que tenga un video visible.
     * 4. La que tenga mayor área de video.
     */
    for (const page of youtubePages) {
        try {
            const score = await page.evaluate(() => {
                const videos = [
                    ...document.querySelectorAll(
                        "video"
                    )
                ];

                let value = 0;

                for (const video of videos) {
                    const rect =
                        video.getBoundingClientRect();

                    const style =
                        getComputedStyle(video);

                    const visible =
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        rect.width > 1 &&
                        rect.height > 1;

                    if (
                        !video.paused &&
                        !video.ended
                    ) {
                        value += 10_000_000;
                    }

                    if (
                        video.classList.contains(
                            "html5-main-video"
                        )
                    ) {
                        value += 5_000_000;
                    }

                    if (visible) {
                        value += 2_000_000;
                    }

                    if (
                        video.currentSrc ||
                        video.src
                    ) {
                        value += 500_000;
                    }

                    if (video.currentTime > 0) {
                        value += 250_000;
                    }

                    value += Math.min(
                        rect.width * rect.height,
                        1_000_000
                    );
                }

                return value;
            });

            if (score > highestScore) {
                highestScore = score;
                selectedPage = page;
            }
        } catch {
            /*
             * Una pestaña puede estar navegando justo
             * cuando llega el evento MIDI.
             */
        }
    }

    return selectedPage;
}

function isYouTubeUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);

        const hostname =
            url.hostname.toLowerCase();

        return (
            hostname === "youtube.com" ||
            hostname.endsWith(".youtube.com") ||
            hostname === "youtu.be"
        );
    } catch {
        return false;
    }
}

async function seekYouTubeVideo(
    seconds,
    playAfterSeek = true
) {
    return runYouTubeVideoCommand(
        "seek",
        {
            seconds,
            playAfterSeek
        }
    );
}

async function toggleYouTubePlayback() {
    const result =
        await runYouTubeVideoCommand(
            "togglePlayback"
        );

    console.log(
        result.paused
            ? (
                `[YouTube] Pausa en ` +
                `${formatTime(result.currentTime)}`
            )
            : (
                `[YouTube] Reproduciendo desde ` +
                `${formatTime(result.currentTime)}`
            )
    );
}

async function changeYouTubePosition(
    deltaSeconds
) {
    console.log(deltaSeconds);
    const result =
        await runYouTubeVideoCommand(
            "changePosition",
            {
                deltaSeconds
            }
        );

    console.log(
        `[YouTube] Nueva posición: ` +
        `${formatTime(result.currentTime)} ` +
        `/ ${formatTime(result.duration)}`
    );
}

async function toggleYouTubeMute() {
    const result =
        await runYouTubeVideoCommand(
            "toggleMute"
        );

    console.log(
        result.muted
            ? "[YouTube] Mute"
            : (
                `[YouTube] Audio activado ` +
                `(${Math.round(result.volume * 100)}%)`
            )
    );
}

async function setYouTubeVolume(
    midiValue,
    maximumValue = MIDI_VALUE_MAX
) {
    const normalizedValue =
        clamp(
            Number(midiValue),
            0,
            maximumValue
        ) / maximumValue;

    const result =
        await runYouTubeVideoCommand(
            "setVolume",
            {
                volume: normalizedValue
            }
        );

    console.log(
        `[YouTube] Volumen: ` +
        `${Math.round(result.volume * 100)}%`
    );
}

async function cycleYouTubePlaybackRate() {
    const result =
        await runYouTubeVideoCommand(
            "cyclePlaybackRate",
            {
                playbackRates
            }
        );

    console.log(
        `[YouTube] Velocidad: ` +
        `${result.playbackRate}x`
    );
}

function scheduleYouTubePlaybackRatePercent(value) {
    pendingExpressionValue = clamp(
        Number(value),
        0,
        EXPRESSION_VALUE_MAX
    );

    if (
        expressionUpdateInFlight ||
        expressionUpdateTimeout
    ) {
        return;
    }

    const elapsed =
        Date.now() - lastExpressionUpdateAt;

    const delay = Math.max(
        0,
        EXPRESSION_THROTTLE_MS - elapsed
    );

    expressionUpdateTimeout = setTimeout(
        flushYouTubePlaybackRatePercent,
        delay
    );
}

async function flushYouTubePlaybackRatePercent() {
    expressionUpdateTimeout = null;

    if (expressionUpdateInFlight) {
        return;
    }

    const value = pendingExpressionValue;
    pendingExpressionValue = null;

    if (value === null) {
        return;
    }

    expressionUpdateInFlight = true;

    try {
        await setYouTubePlaybackRatePercent(value);
    } catch (error) {
        console.error(
            "[YouTube] Error actualizando velocidad:",
            error.message
        );
    } finally {
        expressionUpdateInFlight = false;
        lastExpressionUpdateAt = Date.now();

        if (pendingExpressionValue !== null) {
            scheduleYouTubePlaybackRatePercent(
                pendingExpressionValue
            );
        }
    }
}

async function setYouTubePlaybackRatePercent(value) {
    const percent = clamp(
        Number(value),
        0,
        EXPRESSION_VALUE_MAX
    );

    const playbackRate =
        clamp(
            percent / 100,
            MIN_PLAYBACK_RATE,
            1
        );

    const result =
        await runYouTubeVideoCommand(
            "setPlaybackRate",
            {
                playbackRate,
                minimumPlaybackRate: MIN_PLAYBACK_RATE
            }
        );

    console.log(
        `[YouTube] Velocidad: ` +
        `${Math.round(result.playbackRate * 100)}% ` +
        `(${result.playbackRate}x)`
    );
}

async function toggleYouTubeCaptions() {
    await clickYouTubePlayerButton(
        [
            ".ytp-subtitles-button"
        ],
        "el botón de subtítulos"
    );

    console.log(
        "[YouTube] Subtítulos alternados."
    );
}

async function toggleYouTubeFullscreen() {
    await clickYouTubePlayerButton(
        [
            ".ytp-fullscreen-button"
        ],
        "el botón de pantalla completa"
    );

    console.log(
        "[YouTube] Pantalla completa alternada."
    );
}

async function goToNextYouTubeVideo() {
    await clickYouTubePlayerButton(
        [
            ".ytp-next-button"
        ],
        "el botón de siguiente video"
    );

    console.log(
        "[YouTube] Siguiente video."
    );
}

async function goToPreviousYouTubeVideo() {
    await clickYouTubePlayerButton(
        [
            ".ytp-prev-button"
        ],
        "el botón de video anterior"
    );

    console.log(
        "[YouTube] Video anterior."
    );
}

async function runYouTubeVideoCommand(
    command,
    payload = {}
) {
    const page = await findYouTubePage();

    const result = await page.evaluate(
        async ({ command, payload }) => {
            const videos = [
                ...document.querySelectorAll(
                    "video"
                )
            ].filter(
                video => video.isConnected
            );

            if (videos.length === 0) {
                throw new Error(
                    "No se encontró ningún <video>. " +
                    "Abrí un video de YouTube antes " +
                    "de usar el controlador."
                );
            }

            const isVisible = element => {
                const style =
                    getComputedStyle(element);

                const rect =
                    element.getBoundingClientRect();

                return (
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    Number(style.opacity) !== 0 &&
                    rect.width > 1 &&
                    rect.height > 1 &&
                    rect.bottom > 0 &&
                    rect.right > 0 &&
                    rect.top < innerHeight &&
                    rect.left < innerWidth
                );
            };

            const scoreVideo = video => {
                const rect =
                    video.getBoundingClientRect();

                const visibleArea =
                    isVisible(video)
                        ? Math.max(
                            0,
                            rect.width * rect.height
                        )
                        : 0;

                let score = Math.min(
                    visibleArea,
                    2_000_000
                );

                if (
                    !video.paused &&
                    !video.ended
                ) {
                    score += 10_000_000;
                }

                if (
                    video.classList.contains(
                        "html5-main-video"
                    )
                ) {
                    score += 5_000_000;
                }

                if (
                    video.closest(
                        "#movie_player"
                    )
                ) {
                    score += 3_000_000;
                }

                if (isVisible(video)) {
                    score += 2_000_000;
                }

                if (
                    video.currentSrc ||
                    video.src
                ) {
                    score += 500_000;
                }

                if (video.currentTime > 0) {
                    score += 250_000;
                }

                if (
                    video.readyState >=
                    HTMLMediaElement.HAVE_METADATA
                ) {
                    score += 100_000;
                }

                return score;
            };

            const video = videos
                .map(item => ({
                    item,
                    score: scoreVideo(item)
                }))
                .sort(
                    (a, b) => b.score - a.score
                )[0]?.item;

            if (!video) {
                throw new Error(
                    "No se pudo seleccionar " +
                    "el video activo."
                );
            }

            const player =
                document.querySelector("#movie_player");

            const hasPlayerMethod = method => (
                player &&
                typeof player[method] === "function"
            );

            const waitForMetadata =
                async () => {
                    if (
                        video.readyState >=
                        HTMLMediaElement.HAVE_METADATA
                    ) {
                        return;
                    }

                    await new Promise(
                        (resolve, reject) => {
                            const timeout =
                                setTimeout(
                                    () => reject(
                                        new Error(
                                            "Timeout cargando " +
                                            "metadatos del video."
                                        )
                                    ),
                                    5000
                                );

                            const finish =
                                callback => {
                                    clearTimeout(
                                        timeout
                                    );

                                    callback();
                                };

                            video.addEventListener(
                                "loadedmetadata",
                                () => finish(resolve),
                                {
                                    once: true
                                }
                            );

                            video.addEventListener(
                                "error",
                                () => finish(
                                    () => reject(
                                        new Error(
                                            "Error cargando el " +
                                            "video de YouTube."
                                        )
                                    )
                                ),
                                {
                                    once: true
                                }
                            );
                        }
                    );
                };

            const clampValue = (
                value,
                minimum,
                maximum
            ) => Math.min(
                Math.max(
                    value,
                    minimum
                ),
                maximum
            );

            const playerNumber = method => {
                if (!hasPlayerMethod(method)) {
                    return NaN;
                }

                const value = player[method]();

                return Number.isFinite(value)
                    ? value
                    : NaN;
            };

            const getDuration = fallback => {
                const playerDuration =
                    playerNumber("getDuration");

                if (playerDuration > 0) {
                    return playerDuration;
                }

                if (Number.isFinite(video.duration)) {
                    return video.duration;
                }

                return fallback;
            };

            const getCurrentTime = () => {
                const playerCurrentTime =
                    playerNumber("getCurrentTime");

                return Number.isFinite(playerCurrentTime)
                    ? playerCurrentTime
                    : video.currentTime;
            };

            const seekTo = async (
                seconds,
                playAfterSeek
            ) => {
                const targetSeconds =
                    clampValue(
                        seconds,
                        0,
                        getDuration(seconds)
                    );

                if (hasPlayerMethod("seekTo")) {
                    player.seekTo(targetSeconds, true);
                } else {
                    video.currentTime = targetSeconds;
                }

                await new Promise(resolve =>
                    setTimeout(resolve, 250)
                );

                if (playAfterSeek) {
                    if (hasPlayerMethod("playVideo")) {
                        player.playVideo();
                    } else {
                        await video.play();
                    }
                }
            };

            const state = () => ({
                currentTime:
                    getCurrentTime(),

                duration:
                    getDuration(video.duration),

                paused:
                    hasPlayerMethod("getPlayerState")
                        ? ![1, 3].includes(
                            player.getPlayerState()
                        )
                        : video.paused,

                muted:
                    hasPlayerMethod("isMuted")
                        ? player.isMuted()
                        : video.muted,

                volume:
                    hasPlayerMethod("getVolume")
                        ? player.getVolume() / 100
                        : video.volume,

                playbackRate:
                    Number.isFinite(video.playbackRate)
                        ? video.playbackRate
                        : (
                            hasPlayerMethod("getPlaybackRate")
                                ? player.getPlaybackRate()
                                : 1
                        ),

                title:
                    document.querySelector(
                        "h1.ytd-watch-metadata " +
                        "yt-formatted-string"
                    )?.textContent?.trim() ||
                    document.title
            });

            switch (command) {
                case "seek": {
                    await waitForMetadata();

                    await seekTo(
                        payload.seconds,
                        payload.playAfterSeek
                    );

                    return state();
                }

                case "togglePlayback":
                    await waitForMetadata();

                    if (
                        video.paused ||
                        video.ended
                    ) {
                        await video.play();
                    } else {
                        video.pause();
                    }

                    return state();

                case "changePosition": {
                    await waitForMetadata();

                    await seekTo(
                        payload.deltaSeconds,
                        false
                    );

                    return state();
                }

                case "toggleMute":
                    if (
                        hasPlayerMethod("isMuted") &&
                        hasPlayerMethod("mute") &&
                        hasPlayerMethod("unMute")
                    ) {
                        if (player.isMuted()) {
                            player.unMute();
                        } else {
                            player.mute();
                        }
                    } else {
                        video.muted =
                            !video.muted;
                    }

                    return state();

                case "setVolume":
                    if (hasPlayerMethod("setVolume")) {
                        player.setVolume(
                            Math.round(
                                clampValue(
                                    payload.volume,
                                    0,
                                    1
                                ) * 100
                            )
                        );
                    } else {
                        video.volume =
                            clampValue(
                                payload.volume,
                                0,
                                1
                            );
                    }

                    if (payload.volume > 0) {
                        if (hasPlayerMethod("unMute")) {
                            player.unMute();
                        } else {
                            video.muted = false;
                        }
                    }

                    return state();

                case "setPlaybackRate": {
                    const nextRate =
                        clampValue(
                            payload.playbackRate,
                            payload.minimumPlaybackRate,
                            1
                        );

                    if (
                        hasPlayerMethod("setPlaybackRate") &&
                        hasPlayerMethod(
                            "getAvailablePlaybackRates"
                        )
                    ) {
                        const availableRates =
                            player
                                .getAvailablePlaybackRates()
                                .filter(rate =>
                                    rate >=
                                    payload.minimumPlaybackRate &&
                                    rate <= 1
                                );

                        if (availableRates.length > 0) {
                            const nearestRate =
                                availableRates.reduce(
                                    (closest, rate) => (
                                        Math.abs(
                                            rate - nextRate
                                        ) <
                                        Math.abs(
                                            closest - nextRate
                                        )
                                            ? rate
                                            : closest
                                    )
                                );

                            player.setPlaybackRate(
                                nearestRate
                            );
                        }
                    }

                    video.defaultPlaybackRate =
                        nextRate;

                    video.playbackRate =
                        nextRate;

                    await new Promise(resolve =>
                        setTimeout(resolve, 30)
                    );

                    video.defaultPlaybackRate =
                        nextRate;

                    video.playbackRate =
                        nextRate;

                    return state();
                }

                case "cyclePlaybackRate": {
                    const rates =
                        payload.playbackRates;

                    const currentIndex =
                        rates.findIndex(
                            rate =>
                                Math.abs(
                                    rate -
                                    video.playbackRate
                                ) < 0.01
                        );

                    const nextIndex =
                        currentIndex >= 0
                            ? (
                                currentIndex + 1
                            ) % rates.length
                            : rates.findIndex(
                                rate => rate >= 1
                            );

                    const nextRate =
                        rates[
                            nextIndex >= 0
                                ? nextIndex
                                : 0
                        ];

                    if (hasPlayerMethod("setPlaybackRate")) {
                        player.setPlaybackRate(nextRate);
                    } else {
                        video.defaultPlaybackRate =
                            nextRate;

                        video.playbackRate =
                            nextRate;
                    }

                    return state();
                }

                default:
                    throw new Error(
                        `Comando de video desconocido: ` +
                        `${command}`
                    );
            }
        },
        {
            command,
            payload
        }
    );

    rememberYouTubeState(result);

    return result;
}

async function clickYouTubePlayerButton(
    selectors,
    description
) {
    const page = await findYouTubePage();

    /*
     * Movemos el mouse sobre el reproductor para
     * hacer visibles los controles inferiores.
     */
    const player =
        await page.$("#movie_player");

    if (player) {
        const bounds =
            await player.boundingBox();

        if (bounds) {
            await page.mouse.move(
                bounds.x +
                bounds.width / 2,

                bounds.y +
                Math.max(
                    1,
                    bounds.height - 25
                )
            );

            await sleep(100);
        }
    }

    for (const selector of selectors) {
        const button =
            await page.$(selector);

        if (!button) {
            continue;
        }

        const usable =
            await button.evaluate(
                element => {
                    const style =
                        getComputedStyle(
                            element
                        );

                    const rect =
                        element
                            .getBoundingClientRect();

                    const disabled =
                        element.disabled ||
                        element.getAttribute(
                            "aria-disabled"
                        ) === "true";

                    return (
                        !disabled &&
                        style.display !== "none" &&
                        style.visibility !==
                            "hidden" &&
                        rect.width > 0 &&
                        rect.height > 0
                    );
                }
            );

        if (!usable) {
            continue;
        }

        await button.click();
        return;
    }

    throw new Error(
        `No se encontró ${description} disponible.`
    );
}

function parseCliArguments(args) {
    let initialUrl = YOUTUBE_HOME;
    let markerOffset = 0;

    if (
        args[0] &&
        looksLikeYouTubeAddress(args[0])
    ) {
        initialUrl =
            normalizeYouTubeUrl(args[0]);

        markerOffset = 1;
    }

    return {
        initialUrl,

        marker1: parseTime(
            args[markerOffset] ??
            "1:35"
        ),

        marker2: parseTime(
            args[markerOffset + 1] ??
            "2:50"
        )
    };
}

function looksLikeYouTubeAddress(value) {
    const text =
        String(value)
            .trim()
            .toLowerCase();

    return (
        text.startsWith("http://") ||
        text.startsWith("https://") ||
        text.startsWith(
            "www.youtube.com"
        ) ||
        text.startsWith(
            "youtube.com"
        ) ||
        text.startsWith(
            "youtu.be"
        )
    );
}

function normalizeYouTubeUrl(value) {
    let text =
        String(value).trim();

    if (!/^https?:\/\//i.test(text)) {
        text = `https://${text}`;
    }

    if (!isYouTubeUrl(text)) {
        throw new Error(
            `La URL no pertenece a YouTube: ${value}`
        );
    }

    return text;
}

function parseTime(value) {
    if (typeof value === "number") {
        return ensureValidTime(value);
    }

    const text =
        String(value).trim();

    /*
     * Un número sin ":" representa segundos.
     */
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        return ensureValidTime(
            Number(text)
        );
    }

    const parts =
        text.split(":").map(Number);

    if (
        parts.length < 2 ||
        parts.length > 3 ||
        parts.some(
            part =>
                !Number.isFinite(part) ||
                part < 0
        )
    ) {
        throw new Error(
            `Tiempo inválido: "${value}". ` +
            "Usá segundos, mm:ss o hh:mm:ss."
        );
    }

    const seconds =
        parts.reduce(
            (total, part) =>
                total * 60 + part,
            0
        );

    return ensureValidTime(seconds);
}

function ensureValidTime(seconds) {
    if (
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        throw new Error(
            `Tiempo inválido: ${seconds}`
        );
    }

    return seconds;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) {
        return "--:--";
    }

    const rounded =
        Math.max(
            0,
            Math.floor(seconds)
        );

    const hours =
        Math.floor(rounded / 3600);

    const minutes =
        Math.floor(
            (rounded % 3600) / 60
        );

    const remainingSeconds =
        rounded % 60;

    if (hours > 0) {
        return [
            hours,
            minutes,
            remainingSeconds
        ]
            .map(
                (part, index) =>
                    index === 0
                        ? String(part)
                        : String(part)
                            .padStart(
                                2,
                                "0"
                            )
            )
            .join(":");
    }

    return (
        `${minutes}:` +
        String(remainingSeconds)
            .padStart(2, "0")
    );
}

function clamp(
    value,
    minimum,
    maximum
) {
    return Math.min(
        Math.max(
            value,
            minimum
        ),
        maximum
    );
}

function sleep(milliseconds) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                milliseconds
            )
    );
}

async function shutdown() {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        "\nCerrando controlador..."
    );

    if (
        midiProcess &&
        !midiProcess.killed
    ) {
        midiProcess.kill();
    }

    if (browser) {
        await browser.close();
    }
}

for (
    const signal of [
        "SIGINT",
        "SIGTERM"
    ]
) {
    process.on(
        signal,
        async () => {
            await shutdown();
            process.exit(0);
        }
    );
}

process.on(
    "uncaughtException",
    async error => {
        console.error(error);

        await shutdown();

        process.exit(1);
    }
);

process.on(
    "unhandledRejection",
    async error => {
        console.error(error);

        await shutdown();

        process.exit(1);
    }
);

main().catch(
    async error => {
        console.error(error);

        await shutdown();

        process.exit(1);
    }
);
