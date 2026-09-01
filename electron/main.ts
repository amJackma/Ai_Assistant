import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { config } from 'dotenv'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  RealtimeAssistantService,
  type AudioSource,
  type AnswerDelta,
  type AcceptedRequest,
  type LiveAssistantStatus,
  type TranscriptUpdate,
} from './services/realtimeAssistantService'
import { UtteranceBuffer } from './services/utteranceBuffer'
import {
  SessionMemoryService,
  type AnswerContext,
  type ConversationSegment,
} from './services/sessionMemoryService'
import {
  ScreenCaptureService,
  type SelectionRectangle,
} from './services/screenCaptureService'
import {
  WorkspaceMemoryService,
  type WorkspaceContext,
  type WorkspaceMessage,
} from './services/workspaceMemoryService'
import {
  isTranscriptionArtifact,
  validateEnglishTranscript,
} from './services/transcriptLanguageValidator'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const OPACITY_STEP = 0.1
const MIN_OPACITY = 0.3
const MAX_OPACITY = 1
const MOVE_DISTANCE = 50
const DEFAULT_PRIVACY_MODE = true
const MIN_MEANINGFUL_WORDS = 2
const MIN_SINGLE_PHRASE_CHARACTERS = 8
const DUPLICATE_WINDOW_MS = 5000
const MAX_ACCEPTED_TRANSCRIPTS = 8
const MIN_CAPTURE_SIZE = 24

const NOISE_TRANSCRIPTS = new Set([
  'uh',
  'um',
  'hm',
  'hmm',
  'ah',
  'okay',
  'yeah',
  'yes',
  'you',
  'the',
  'thank you',
  'thanks for watching',
  'music',
  'silence',
  'background noise',
  'inaudible',
])

let overlayWindow: BrowserWindow | null = null
type AudioMode = 'microphone' | 'system' | 'both'

const realtimeAssistants = new Map<AudioSource, RealtimeAssistantService>()
const utteranceBuffers = new Map<AudioSource, UtteranceBuffer>()
let finalizedTurnQueue: Promise<void> = Promise.resolve()
let activeResponse: {
  assistant: RealtimeAssistantService
  request: AcceptedRequest
  conversationSnapshot: ConversationSegment[]
  memoryGeneration: number
  temporaryAssistant: boolean
} | null = null
let acceptedRequests: AcceptedRequest[] = []
let privacyMode = false
let privacyModeError: string | undefined
type ScreenCaptureState = 'IDLE' | 'SELECTING' | 'CAPTURING' | 'ANALYZING' | 'RESPONDING'
let screenCaptureState: ScreenCaptureState = 'IDLE'
const selectionWindows = new Map<number, { window: BrowserWindow; displayId: number }>()
let overlayWasVisibleBeforeCapture = false

config({ path: path.join(app.getAppPath(), '.env') })
const sessionMemory = new SessionMemoryService(
  process.env.OPENAI_API_KEY ?? '',
  (message) => {
    if (!app.isPackaged) console.info(message)
  },
)
const screenCaptureService = new ScreenCaptureService()
const workspaceMemory = new WorkspaceMemoryService(
  process.env.OPENAI_API_KEY ?? '',
  (message) => { if (!app.isPackaged) console.info(message) },
)

function addWorkspaceMessage(message: WorkspaceMessage) {
  workspaceMemory.addMessage(message)
  sendToOverlay('workspace:message', message)
}

function sendToOverlay(channel: string, value: unknown) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel, value)
  }
}

function isOverlaySender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return event.sender === overlayWindow?.webContents
}

interface PrivacyModeResult {
  success: boolean
  enabled: boolean
  error?: string
}

function applyPrivacyMode(enabled: boolean): PrivacyModeResult {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return {
      success: false,
      enabled: privacyMode,
      error: 'The overlay window is not available.',
    }
  }

  try {
    overlayWindow.setContentProtection(enabled)
    privacyMode = enabled
    privacyModeError = undefined
    if (!app.isPackaged) {
      console.info(`Privacy Mode ${enabled ? 'enabled' : 'disabled'}`)
    }
    return { success: true, enabled: privacyMode }
  } catch {
    privacyModeError = 'Windows content protection could not be changed.'
    return {
      success: false,
      enabled: privacyMode,
      error: privacyModeError,
    }
  }
}

function moveOverlay(deltaX: number, deltaY: number) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  const [x, y] = overlayWindow.getPosition()
  overlayWindow.setPosition(x + deltaX, y + deltaY)
}

function toggleOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return

  if (overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    overlayWindow.show()
  }
}

function changeOpacity(direction: -1 | 1) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return MIN_OPACITY

  const nextOpacity = Math.min(
    MAX_OPACITY,
    Math.max(
      MIN_OPACITY,
      Math.round((overlayWindow.getOpacity() + direction * OPACITY_STEP) * 10) /
        10,
    ),
  )

  overlayWindow.setOpacity(nextOpacity)
  return nextOpacity
}

function registerShortcuts() {
  globalShortcut.register('Control+Alt+Left', () =>
    moveOverlay(-MOVE_DISTANCE, 0),
  )
  globalShortcut.register('Control+Alt+Right', () =>
    moveOverlay(MOVE_DISTANCE, 0),
  )
  globalShortcut.register('Control+Alt+Up', () =>
    moveOverlay(0, -MOVE_DISTANCE),
  )
  globalShortcut.register('Control+Alt+Down', () =>
    moveOverlay(0, MOVE_DISTANCE),
  )
  globalShortcut.register('Control+Alt+B', toggleOverlayVisibility)
  globalShortcut.register('Control+Alt+S', () => void startRegionCapture())
}

function registerOpacityHandlers() {
  ipcMain.handle('overlay:get-opacity', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return overlayWindow?.getOpacity() ?? 1
  })
  ipcMain.handle('overlay:increase-opacity', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return changeOpacity(1)
  })
  ipcMain.handle('overlay:decrease-opacity', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return changeOpacity(-1)
  })
  ipcMain.handle('overlay:get-privacy-mode', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return {
      success: privacyModeError === undefined,
      enabled: privacyMode,
      error: privacyModeError,
    } satisfies PrivacyModeResult
  })
  ipcMain.handle('overlay:set-privacy-mode', (event, enabled: unknown) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    if (typeof enabled !== 'boolean') {
      return {
        success: false,
        enabled: privacyMode,
        error: 'Privacy Mode requires a boolean value.',
      } satisfies PrivacyModeResult
    }
    return applyPrivacyMode(enabled)
  })
}

function registerScreenCaptureHandlers() {
  ipcMain.handle('screen-capture:start', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return startRegionCapture()
  })
  ipcMain.on('screen-capture:selected', (event, value: unknown) => {
    const selectionWindow = selectionWindows.get(event.sender.id)
    if (!selectionWindow) return
    const rectangle = parseSelectionRectangle(value)
    if (!rectangle || rectangle.width < MIN_CAPTURE_SIZE || rectangle.height < MIN_CAPTURE_SIZE) {
      cancelRegionCapture()
      return
    }
    void finishRegionSelection(selectionWindow.displayId, rectangle)
  })
  ipcMain.on('screen-capture:cancel', (event) => {
    if (!selectionWindows.has(event.sender.id)) return
    cancelRegionCapture()
  })
}

function startRegionCapture() {
  if (screenCaptureState !== 'IDLE' || activeResponse) {
    sendToOverlay(
      'screen-capture:error',
      activeResponse
        ? 'Wait for the current AI response to finish.'
        : 'Screen capture is already active.',
    )
    return false
  }

  screenCaptureState = 'SELECTING'
  sendToOverlay('screen-capture:state', screenCaptureState)
  overlayWasVisibleBeforeCapture = Boolean(overlayWindow?.isVisible())
  overlayWindow?.hide()

  for (const display of screen.getAllDisplays()) {
    const selectionWindow = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000001',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(currentDirectory, 'preload.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    selectionWindows.set(selectionWindow.webContents.id, {
      window: selectionWindow,
      displayId: display.id,
    })
    selectionWindow.setAlwaysOnTop(true, 'screen-saver')
    void selectionWindow.loadURL(createSelectionPageUrl())
  }

  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const cursorWindow = [...selectionWindows.values()].find(
    (entry) => entry.displayId === cursorDisplay.id,
  )?.window
  cursorWindow?.focus()
  return true
}

function cancelRegionCapture() {
  closeSelectionWindows()
  screenCaptureState = 'IDLE'
  restoreOverlayAfterCapture()
  sendToOverlay('screen-capture:state', screenCaptureState)
}

async function finishRegionSelection(
  displayId: number,
  rectangle: SelectionRectangle,
) {
  if (screenCaptureState !== 'SELECTING') return
  screenCaptureState = 'CAPTURING'
  sendToOverlay('screen-capture:state', screenCaptureState)
  closeSelectionWindows()

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const png = await screenCaptureService.captureRegion(displayId, rectangle)
    restoreOverlayAfterCapture()
    screenCaptureState = 'ANALYZING'
    sendToOverlay('screen-capture:state', screenCaptureState)
    await analyzeCapturedImage(png)
  } catch (error) {
    restoreOverlayAfterCapture()
    screenCaptureState = 'IDLE'
    sendToOverlay('screen-capture:state', screenCaptureState)
    sendToOverlay(
      'screen-capture:error',
      error instanceof Error ? error.message : 'The selected region could not be captured.',
    )
  }
}

function closeSelectionWindows() {
  for (const { window } of selectionWindows.values()) {
    if (!window.isDestroyed()) window.destroy()
  }
  selectionWindows.clear()
}

function restoreOverlayAfterCapture() {
  if (overlayWasVisibleBeforeCapture && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show()
  }
  overlayWasVisibleBeforeCapture = false
}

function parseSelectionRectangle(value: unknown): SelectionRectangle | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.x !== 'number' ||
    typeof candidate.y !== 'number' ||
    typeof candidate.width !== 'number' ||
    typeof candidate.height !== 'number' ||
    !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) ||
    !Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)
  ) return null
  return {
    x: Math.max(0, candidate.x),
    y: Math.max(0, candidate.y),
    width: Math.max(0, candidate.width),
    height: Math.max(0, candidate.height),
  }
}

function createSelectionPageUrl() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:rgba(2,6,23,.28)}
    #hint{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:8px 12px;border-radius:8px;color:#fff;background:rgba(15,23,42,.9);font:600 13px Segoe UI,sans-serif;pointer-events:none}
    #selection{display:none;position:fixed;border:2px solid #38bdf8;background:rgba(56,189,248,.12);box-shadow:0 0 0 99999px rgba(2,6,23,.24);pointer-events:none}
  </style></head><body><div id="hint">Drag to select • Esc to cancel</div><div id="selection"></div><script>
    const box=document.getElementById('selection');let start=null;
    addEventListener('mousedown',e=>{if(e.button!==0)return;start={x:e.clientX,y:e.clientY};box.style.display='block'});
    addEventListener('mousemove',e=>{if(!start)return;const x=Math.min(start.x,e.clientX),y=Math.min(start.y,e.clientY),w=Math.abs(e.clientX-start.x),h=Math.abs(e.clientY-start.y);Object.assign(box.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'})});
    addEventListener('mouseup',e=>{if(!start||e.button!==0)return;const rect={x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(e.clientX-start.x),height:Math.abs(e.clientY-start.y)};start=null;window.selectionAPI.select(rect)});
    addEventListener('keydown',e=>{if(e.key==='Escape')window.selectionAPI.cancel()});
  </script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function registerLiveAssistantHandlers() {
  ipcMain.handle('live-assistant:start', async (event, mode: unknown) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    if (!isAudioMode(mode)) throw new Error('Invalid audio source mode.')

    stopRealtimeAssistants()
    sessionMemory.reset()
    const sources: AudioSource[] =
      mode === 'both' ? ['microphone', 'system'] : [mode]

    for (const source of sources) {
      const assistant = createRealtimeAssistant(source)
      realtimeAssistants.set(source, assistant)
    }

    try {
      await Promise.all(
        [...realtimeAssistants.values()].map((assistant) =>
          assistant.start(process.env.OPENAI_API_KEY ?? ''),
        ),
      )
      if (!app.isPackaged) {
        console.info(`[AUDIO] source = ${mode}`)
        console.info('[SESSION] started')
        console.info('[CAPTURE] active')
      }
    } catch (error) {
      stopRealtimeAssistants()
      throw error
    }
  })
  ipcMain.handle('live-assistant:stop', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    stopRealtimeAssistants()
    sessionMemory.reset()
    if (!app.isPackaged) console.info('[SESSION] stopped')
  })
  ipcMain.handle('live-assistant:reset-context', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    sessionMemory.reset()
  })
  ipcMain.handle('workspace:get-history', (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    return workspaceMemory.getRecentMessages()
  })
  ipcMain.handle('workspace:send-text', async (event, value: unknown) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || text.length > 10000) {
      return { success: false, error: 'Enter a message before sending.' }
    }
    if (activeResponse || screenCaptureState !== 'IDLE') {
      return { success: false, error: 'Wait for the current AI response to finish.' }
    }

    const { assistant, source, temporaryAssistant } = await getWorkspaceAssistant()
    const userMessage: WorkspaceMessage = {
      id: randomUUID(),
      type: 'user-text',
      text,
      timestamp: Date.now(),
    }
    addWorkspaceMessage(userMessage)
    const request: AcceptedRequest = {
      id: randomUUID(),
      text,
      normalizedText: normalizeTranscript(text),
      source,
      timestamp: Date.now(),
      requestType: 'text',
    }
    beginResponse(
      assistant,
      request,
      formatWorkspaceTextPrompt(workspaceMemory.createContext(), text),
      [],
      sessionMemory.getGeneration(),
      temporaryAssistant,
    )
    return { success: true, requestId: request.id }
  })
  ipcMain.handle(
    'live-assistant:generate-answer',
    (event, value: unknown) => {
      if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender.')
      const conversation = parseConversationSnapshot(value)
      if (conversation.length === 0) {
        return { success: false, error: 'There is no conversation to answer.' }
      }
      if (activeResponse) {
        return { success: false, error: 'An answer is already being generated.' }
      }
      if (screenCaptureState !== 'IDLE') {
        return { success: false, error: 'Finish or cancel screen capture first.' }
      }

      const preferredSource = conversation.at(-1)?.source
      const assistant =
        (preferredSource && realtimeAssistants.get(preferredSource)) ??
        realtimeAssistants.values().next().value
      if (!assistant) {
        return { success: false, error: 'Start Live Assistant before generating an answer.' }
      }

      const timestamp = Date.now()
      const answerContext = sessionMemory.createAnswerContext(conversation)
      const contextText = formatConversationPrompt(answerContext)
      const request: AcceptedRequest = {
        id: randomUUID(),
        text: conversation.map((segment) => segment.text).join('\n'),
        normalizedText: normalizeTranscript(contextText),
        source: preferredSource ?? 'microphone',
        timestamp,
      }
      sessionMemory.commitConversation(conversation)
      beginResponse(
        assistant,
        request,
        contextText,
        conversation,
        sessionMemory.getGeneration(),
      )
      return { success: true, requestId: request.id }
    },
  )
  ipcMain.on(
    'live-assistant:audio',
    (event, source: unknown, audio: Uint8Array) => {
    if (!isOverlaySender(event)) return
      if (!isAudioSource(source) || !(audio instanceof Uint8Array)) return
      realtimeAssistants.get(source)?.sendAudio(audio)
    },
  )
}

function createRealtimeAssistant(
  source: AudioSource,
  options: { visionOnly?: boolean } = {},
) {
  let assistant: RealtimeAssistantService
  assistant = new RealtimeAssistantService(source, {
    onStatus: (status: LiveAssistantStatus) => {
      if (status === 'USER SPEAKING') {
        utteranceBuffers.get(source)?.speechStarted()
      }
      if (!options.visionOnly) sendToOverlay('live-assistant:status', status)
    },
    onTranscript: (update: TranscriptUpdate) => {
      if (!update.interim) {
        sendToOverlay('live-assistant:transcript', update)
        return
      }
      if (isTranscriptionArtifact(update.interim)) return
      const validation = validateEnglishTranscript(update.interim)
      if (!validation.valid) return
      sendToOverlay('live-assistant:transcript', {
        ...update,
        interim: validation.text,
      })
    },
    onAnswerDelta: (update: AnswerDelta) => {
      if (
        activeResponse?.assistant !== assistant ||
        activeResponse.request.id !== update.requestId
      ) {
        if (!app.isPackaged) console.info(`[ANSWER] stale delta ignored id=${update.requestId}`)
        return
      }
      if (update.reset && !app.isPackaged) {
        console.info(`[ANSWER] first delta id=${update.requestId}`)
      }
      if (update.reset && update.requestType === 'image') {
        screenCaptureState = 'RESPONDING'
        sendToOverlay('screen-capture:state', screenCaptureState)
      }
      sendToOverlay('live-assistant:answer-delta', update)
    },
    onAnswerComplete: (request, answer) => {
      if (activeResponse?.request.id !== request.id) return
      const completedResponse = activeResponse
      if (!request.requestType || request.requestType === 'conversation') {
        sessionMemory.recordInteraction(
          request.id,
          activeResponse.conversationSnapshot,
          answer,
          activeResponse.memoryGeneration,
        )
      }
      if (request.requestType === 'image' || request.requestType === 'text') {
        const workspaceMessage: WorkspaceMessage = {
          id: randomUUID(),
          type: 'assistant',
          text: answer,
          timestamp: Date.now(),
          requestId: request.id,
        }
        workspaceMemory.recordAssistantResponse(workspaceMessage)
        sendToOverlay('workspace:message', workspaceMessage)
      }
      if (!app.isPackaged) console.info(`[ANSWER] completed id=${request.id}`)
      activeResponse = null
      sendToOverlay('live-assistant:answer-complete', request.id)
      if (request.requestType === 'image') {
        screenCaptureState = 'IDLE'
        sendToOverlay('screen-capture:state', screenCaptureState)
      }
      if (completedResponse.temporaryAssistant) {
        completedResponse.assistant.stop()
        if (realtimeAssistants.get(request.source) === completedResponse.assistant) {
          realtimeAssistants.delete(request.source)
          utteranceBuffers.get(request.source)?.clear()
          utteranceBuffers.delete(request.source)
        }
      }
    },
    onStaleAnswer: (requestId) => {
      if (!app.isPackaged) console.info(`[ANSWER] stale delta ignored id=${requestId}`)
    },
    onError: (message: string) => {
      if (
        activeResponse?.assistant === assistant &&
        (activeResponse.request.requestType === 'image' ||
          activeResponse.request.requestType === 'text')
      ) {
        const temporary = activeResponse.temporaryAssistant
        const request = activeResponse.request
        activeResponse = null
        sendToOverlay('live-assistant:answer-complete', request.id)
        if (request.requestType === 'image') {
          screenCaptureState = 'IDLE'
          sendToOverlay('screen-capture:state', screenCaptureState)
          sendToOverlay('screen-capture:error', message)
        } else {
          sendToOverlay('live-assistant:error', message)
        }
        if (temporary) {
          assistant.stop()
          if (realtimeAssistants.get(source) === assistant) realtimeAssistants.delete(source)
        }
        return
      }
      sendToOverlay('live-assistant:error', message)
    },
    onTranscriptFragment: (finalSource, transcript) => {
      if (isTranscriptionArtifact(transcript)) {
        utteranceBuffers.get(finalSource)?.ignoredFragment()
        if (!app.isPackaged) {
          console.info('[TRANSCRIPT] rejected: internal prompt echo')
        }
        return
      }
      const validation = validateEnglishTranscript(transcript)
      if (!validation.valid) {
        utteranceBuffers.get(finalSource)?.ignoredFragment()
        if (!app.isPackaged) {
          console.info('[LANGUAGE] transcript rejected: unexpected script')
        }
        return
      }
      if (!app.isPackaged) {
        console.info(
          validation.normalizedArtifact
            ? '[LANGUAGE] isolated artifact normalized'
            : '[LANGUAGE] English transcript accepted',
        )
      }
      utteranceBuffers.get(finalSource)?.addFragment(validation.text)
    },
  })
  utteranceBuffers.set(
    source,
    new UtteranceBuffer({
      onWaiting: () => sendToOverlay('live-assistant:status', 'LISTENING'),
      onFinalized: (utterance) => {
        sendToOverlay('live-assistant:status', 'PROCESSING')
        finalizedTurnQueue = finalizedTurnQueue
          .then(async () => {
            if (realtimeAssistants.get(source) !== assistant) return
            await coordinateFinalizedTurn(source, utterance, assistant)
            sendToOverlay('live-assistant:status', 'LISTENING')
            if (!app.isPackaged) console.info('[TURN] ready for next request')
          })
          .catch(() => {
            // A turn-level failure is recoverable; capture remains active.
            if (realtimeAssistants.get(source) === assistant) {
              sendToOverlay('live-assistant:status', 'LISTENING')
            }
          })
      },
      log: (message) => {
        if (!app.isPackaged) console.info(`[TURN] ${message}`)
      },
    }),
  )
  return assistant
}

async function coordinateFinalizedTurn(
  source: AudioSource,
  transcript: string,
  assistant: RealtimeAssistantService,
): Promise<boolean> {
  const now = Date.now()
  const normalizedText = normalizeTranscript(transcript)
  if (!isMeaningfulTranscript(normalizedText)) {
    logRequestDecision('rejected: local noise or too short')
    return false
  }

  acceptedRequests = acceptedRequests.filter(
    (request) => now - request.timestamp < DUPLICATE_WINDOW_MS,
  )

  if (
    acceptedRequests.some((request) =>
      areDuplicates(request.normalizedText, normalizedText),
    )
  ) {
    logRequestDecision('rejected: duplicate accepted request')
    return false
  }

  if (realtimeAssistants.get(source) !== assistant) return false

  const segment: ConversationSegment = {
    id: randomUUID(),
    text: transcript.trim(),
    source,
    timestamp: now,
  }
  const request: AcceptedRequest = { ...segment, normalizedText }
  rememberAcceptedRequest(request)
  sendToOverlay('live-assistant:conversation-segment', segment)
  if (!app.isPackaged) console.info(`[TRANSCRIPT] captured id=${segment.id}`)
  return true
}

function beginResponse(
  assistant: RealtimeAssistantService,
  request: AcceptedRequest,
  inputText?: string,
  conversationSnapshot: ConversationSegment[] = [],
  memoryGeneration = sessionMemory.getGeneration(),
  temporaryAssistant = false,
) {
  if (activeResponse && activeResponse.request.id !== request.id) {
    activeResponse.assistant.cancelResponse()
  }
  activeResponse = {
    assistant,
    request,
    conversationSnapshot: conversationSnapshot.map((segment) => ({ ...segment })),
    memoryGeneration,
    temporaryAssistant,
  }
  if (!app.isPackaged) console.info(`[ANSWER] generation started id=${request.id}`)
  assistant.createResponse(request, inputText)
}

async function analyzeCapturedImage(png: Buffer) {
  if (activeResponse) throw new Error('Wait for the current AI response to finish.')

  const { assistant, source, temporaryAssistant } = await getWorkspaceAssistant()
  const captureMessage: WorkspaceMessage = {
    id: randomUUID(),
    type: 'screen-capture',
    text: 'Captured a new screenshot for workspace analysis.',
    timestamp: Date.now(),
  }
  addWorkspaceMessage(captureMessage)

  const context = sessionMemory.createAnswerContext([])
  const workspaceContext = workspaceMemory.createContext()
  const request: AcceptedRequest = {
    id: randomUUID(),
    text: 'User-selected screen region',
    normalizedText: 'user selected screen region',
    source,
    timestamp: Date.now(),
    requestType: 'image',
  }
  activeResponse = {
    assistant,
    request,
    conversationSnapshot: [],
    memoryGeneration: sessionMemory.getGeneration(),
    temporaryAssistant,
  }
  if (!app.isPackaged) console.info(`[VISION] analysis started id=${request.id}`)
  assistant.createVisionResponse(
    request,
    formatVisionPrompt(context, workspaceContext),
    `data:image/png;base64,${png.toString('base64')}`,
  )
}

async function getWorkspaceAssistant() {
  let assistant = realtimeAssistants.values().next().value as
    | RealtimeAssistantService
    | undefined
  let temporaryAssistant = false
  let source: AudioSource = 'microphone'
  if (!assistant) {
    temporaryAssistant = true
    assistant = createRealtimeAssistant(source, { visionOnly: true })
    realtimeAssistants.set(source, assistant)
    try {
      await assistant.start(process.env.OPENAI_API_KEY ?? '')
    } catch (error) {
      realtimeAssistants.delete(source)
      utteranceBuffers.get(source)?.clear()
      utteranceBuffers.delete(source)
      throw error
    }
  } else {
    source = [...realtimeAssistants.entries()].find(([, value]) => value === assistant)?.[0] ?? source
  }
  return { assistant, source, temporaryAssistant }
}

function formatVisionPrompt(context: AnswerContext, workspace: WorkspaceContext) {
  const recent = context.recentConversation
    .map((segment) => `${segment.source.toUpperCase()}: ${segment.text}`)
    .join('\n')
  return `Role: Analyze a user-selected screenshot for authorized technical assistance.

Evidence priority:
1. The screenshot is primary.
2. PROBLEM WORKSPACE is the primary continuity context for prior screenshots, code, and typed instructions.
3. Meeting session context is secondary and only clarifies relevant ambiguity.
4. Never let older context override a visible language, signature, constraint, or topic.

Classify the screenshot relative to PROBLEM WORKSPACE as NEW_PROBLEM, PROBLEM_MODIFICATION, FOLLOW_UP, CODE_CHANGE, ERROR_ON_CURRENT_SOLUTION, ADDITIONAL_CONTEXT, or UNRELATED_CONTENT. Use semantic evidence, not exact title matching. Do not force continuity when the screenshot clearly starts an unrelated problem.

For PROBLEM_MODIFICATION, CODE_CHANGE, or FOLLOW_UP, lead with this format instead of repeating a first-time solution explanation:
CHANGE DETECTED
Previous: brief prior requirement
Now: new or changed requirement
WHAT STAYS THE SAME
WHAT NEEDS TO CHANGE
CODE CHANGES
UPDATED SOLUTION (complete code unless the user explicitly requested fragments)
WHY THESE CHANGES WORK
UPDATED COMPLEXITY
Mark only important modifications with // NEW:, // CHANGED:, or // IMPORTANT: comments.

Language priority for related work: explicit new requirement, current workspace language, visible starter code, visible platform language, then a reasonable default.

First classify the screenshot internally as CODING_PROBLEM, CODE_DEBUGGING, ERROR_MESSAGE, TECHNICAL_QUESTION, or OTHER. Do not print the classification unless it helps the answer. Use only the matching response format below.

For CODING_PROBLEM, use this exact high-level order:

MY THOUGHTS

PROBLEM UNDERSTANDING
- Give 2–4 concise bullets stating the required result and important visible constraints.
- Surface the recommended practical approach quickly.

APPROACHES

BRUTE FORCE
Idea: Briefly explain it.
How it works: Give concise steps.
Time Complexity: O(...)
Space Complexity: O(...)

BETTER APPROACH
Include only when a genuinely meaningful intermediate approach exists. Never invent one to fill the template.

OPTIMAL / RECOMMENDED APPROACH
Idea: Explain it clearly.
Why: Explain why this implementation is preferred.
Steps: Give a short numbered sequence.
Time Complexity: O(...)
Space Complexity: O(...)

Before code, include a compact comparison table of only the approaches actually described. Clearly label the implementation you recommend. Distinguish a practical recommendation from an asymptotically optimal algorithm when those differ. Complexity claims must match the described algorithms and final code.

SOLUTION
Provide complete, directly usable code in a fenced code block. Preserve visible starter class/function signatures. Do not add main(), input parsing, dependencies, or boilerplate when the platform expects only a function. Never provide placeholders or pseudocode instead of the implementation.

CODE WALKTHROUGH
Explain the important implementation pieces in concise numbered steps.

COMPLEXITY
Time: O(...)
Space: O(...)

EDGE CASES
Include only relevant cases.

Language priority for coding answers:
1. Explicit screenshot requirement.
2. Language selected or visible in the platform.
3. Visible starter-code language.
4. Relevant session preference.
5. Otherwise choose a reasonable language and state it briefly.
Never choose Python merely because it is shorter when another language is visible.

For CODE_DEBUGGING, do not use algorithm comparisons. Use:
PROBLEM
ROOT CAUSE
FIX
CORRECTED CODE
WHY IT WORKS

For ERROR_MESSAGE, use:
ERROR
LIKELY CAUSE
WHAT TO CHANGE
CORRECTED CODE (only when useful)

For TECHNICAL_QUESTION, use:
DIRECT ANSWER
EXPLANATION
EXAMPLE (only when useful)

For OTHER, respond in the clearest compact structure appropriate to the visible content.

Grounding rules:
- Do not invent invisible text, constraints, examples, or platform requirements.
- If important content is cropped or unreadable, say: "Part of the problem/constraints appears to be outside the captured region."
- If missing content materially changes the algorithm, ask for a larger capture and limit the answer to safe inferences.
- Always respond in English.
- Use headings, bullets, short paragraphs, and compact explanations suitable for a floating overlay.

SESSION SUMMARY:
${context.sessionSummary || '(none)'}

BOUNDED RECENT CONVERSATION:
${recent || '(none)'}

PROBLEM WORKSPACE:
${formatWorkspaceContext(workspace)}

TASK:
Analyze the selected screenshot and return the matching response format.`
}

function formatWorkspaceTextPrompt(workspace: WorkspaceContext, userText: string) {
  return `You are continuing an in-memory coding problem workspace. The newest USER MESSAGE is the request to answer. Resolve references such as "this", "that", "previous code", and "second loop" from CURRENT PROBLEM and RECENT WORKSPACE MESSAGES. Do not treat the message as isolated. Do not force old context onto a clearly unrelated new topic.

For a modification, use CHANGE DETECTED, WHAT STAYS THE SAME, WHAT NEEDS TO CHANGE, CODE CHANGES, UPDATED SOLUTION, WHY THESE CHANGES WORK, and UPDATED COMPLEXITY. Provide complete updated code unless the user explicitly requests only changed lines. Mark only important changes with // NEW:, // CHANGED:, or // IMPORTANT:. Preserve the workspace language unless the user explicitly requests another.

For an explanation question, answer it directly and do not claim to replace the canonical solution. For a new problem, use the standard structured coding-problem format. Always answer in English.

PROBLEM WORKSPACE:
${formatWorkspaceContext(workspace)}

USER MESSAGE:
${userText}`
}

function formatWorkspaceContext(workspace: WorkspaceContext) {
  const problem = workspace.currentProblem
    ? JSON.stringify(workspace.currentProblem, null, 2)
    : '(none yet)'
  const messages = workspace.recentMessages
    .map((message) => `${message.type.toUpperCase()}: ${message.text}`)
    .join('\n\n')
  return `WORKSPACE SUMMARY:\n${workspace.summary || '(none)'}\n\nCURRENT PROBLEM:\n${problem}\n\nRECENT WORKSPACE MESSAGES:\n${messages || '(none)'}`
}

function parseConversationSnapshot(value: unknown): ConversationSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return []
  const segments: ConversationSegment[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return []
    const candidate = item as Record<string, unknown>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.text !== 'string' ||
      candidate.text.trim().length === 0 ||
      candidate.text.length > 10000 ||
      !isAudioSource(candidate.source) ||
      typeof candidate.timestamp !== 'number'
    ) return []
    segments.push({
      id: candidate.id,
      text: candidate.text.trim(),
      source: candidate.source,
      timestamp: candidate.timestamp,
    })
  }
  return segments
}

function formatConversationPrompt(context: AnswerContext) {
  const formatSegments = (segments: ConversationSegment[]) => segments
    .map((segment) => `${segment.source === 'microphone' ? 'MIC' : 'SYSTEM'}:\n${segment.text}`)
    .join('\n\n')
  const interactionHistory = context.recentInteractions
    .map((interaction) =>
      `USER CONTEXT:\n${formatSegments(interaction.conversation)}\nASSISTANT ANSWER:\n${interaction.assistantAnswer}`,
    )
    .join('\n\n')
  return `You are assisting with an ongoing live conversation. Use session context to resolve references such as "it", "that", "this", "they", and references to earlier discussion. CURRENT CONVERSATION has highest priority. RECENT CONVERSATION provides immediate context. SESSION SUMMARY and RECENT INTERACTIONS provide older background only. Do not answer old questions again. Prefer newer information when the topic changes. Always answer in English.\n\nSESSION SUMMARY:\n${context.sessionSummary || '(none)'}\n\nRECENT CONVERSATION:\n${formatSegments(context.recentConversation) || '(none)'}\n\nRECENT INTERACTIONS:\n${interactionHistory || '(none)'}\n\nCURRENT CONVERSATION:\n${formatSegments(context.currentConversation)}\n\nTASK:\nProvide a concise useful answer to the newest request using only relevant context from the ongoing conversation.`
}

function stopRealtimeAssistants() {
  for (const buffer of utteranceBuffers.values()) buffer.clear()
  utteranceBuffers.clear()
  acceptedRequests = []
  const stoppedRequestId = activeResponse?.request.id
  for (const assistant of realtimeAssistants.values()) assistant.stop()
  realtimeAssistants.clear()
  activeResponse = null
  if (stoppedRequestId) sendToOverlay('live-assistant:answer-complete', stoppedRequestId)
  if (screenCaptureState === 'ANALYZING' || screenCaptureState === 'RESPONDING') {
    screenCaptureState = 'IDLE'
    sendToOverlay('screen-capture:state', screenCaptureState)
  }
  finalizedTurnQueue = Promise.resolve()
}

function logRequestDecision(message: string) {
  if (!app.isPackaged) console.info(`[REQUEST] ${message}`)
}

function normalizeTranscript(transcript: string) {
  return transcript.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function isMeaningfulTranscript(normalizedText: string) {
  if (!normalizedText || NOISE_TRANSCRIPTS.has(normalizedText)) return false
  if (/^(uh+|um+|hm+|ah+|oh+|mm+|huh+)$/.test(normalizedText)) return false
  if (normalizedText === 'why' || normalizedText === 'how') return true

  const words = normalizedText
    .split(' ')
    .filter((word) => word.length > 1 && !NOISE_TRANSCRIPTS.has(word))

  return (
    words.length >= MIN_MEANINGFUL_WORDS ||
    (words.length === 1 && words[0].length >= MIN_SINGLE_PHRASE_CHARACTERS)
  )
}

function rememberAcceptedRequest(request: AcceptedRequest) {
  acceptedRequests.push(request)
  acceptedRequests = acceptedRequests.slice(-MAX_ACCEPTED_TRANSCRIPTS)
}

const DUPLICATE_STOP_WORDS = new Set([
  'a', 'about', 'an', 'can', 'could', 'do', 'does', 'explain', 'for', 'how',
  'is', 'me', 'of', 'please', 'tell', 'the', 'to', 'what', 'why', 'would', 'you',
])

function areDuplicates(left: string, right: string) {
  if (!left || !right) return false
  if (left === right) return true
  const contentWords = (text: string) =>
    new Set(text.split(' ').filter((word) => !DUPLICATE_STOP_WORDS.has(word)))
  const leftWords = contentWords(left)
  const rightWords = contentWords(right)
  if (leftWords.size === 0 || rightWords.size === 0) return false
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length
  const union = new Set([...leftWords, ...rightWords]).size
  return shared / union >= 0.9
}

function isAudioSource(value: unknown): value is AudioSource {
  return value === 'microphone' || value === 'system'
}

function isAudioMode(value: unknown): value is AudioMode {
  return isAudioSource(value) || value === 'both'
}

function configureSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (
        request.frame !== overlayWindow?.webContents.mainFrame ||
        !request.audioRequested
      ) {
        callback({})
        return
      }

      void desktopCapturer
        .getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then((sources) => {
          const primaryScreen = sources[0]
          if (!primaryScreen) {
            callback({})
            return
          }
          callback({ video: primaryScreen, audio: 'loopback' })
        })
        .catch(() => callback({}))
    },
  )
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 420,
    height: 260,
    minWidth: 320,
    minHeight: 180,
    center: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: true,
    show: false,
    opacity: 0.7,
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  overlayWindow.setAlwaysOnTop(true, 'floating')
  applyPrivacyMode(DEFAULT_PRIVACY_MODE)
  overlayWindow.once('ready-to-show', () => overlayWindow?.show())
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void overlayWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void overlayWindow.loadFile(path.join(currentDirectory, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createOverlayWindow()
  configureSystemAudioCapture()
  registerOpacityHandlers()
  registerLiveAssistantHandlers()
  registerScreenCaptureHandlers()
  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
  })
})

app.on('will-quit', () => {
  closeSelectionWindows()
  stopRealtimeAssistants()
  globalShortcut.unregisterAll()
})
app.on('window-all-closed', () => app.quit())
