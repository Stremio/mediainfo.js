import type { MediaInfoFactoryOptions } from './MediaInfoFactory'
import type {
  MediaInfoModule,
  MediaInfoWasmInterface,
  WasmConstructableFormatType,
} from './MediaInfoModule'
import type { MediaInfoType } from './types.generated'

/** Format of the result type */
type FormatType = 'object' | WasmConstructableFormatType

type MediaInfoOptions<TFormat extends FormatType> = Required<
  Omit<MediaInfoFactoryOptions<TFormat>, 'locateFile'>
>

interface GetSizeFunc {
  (): Promise<number> | number
}

interface ReadChunkFunc {
  (size: number, offset: number): Promise<Uint8Array> | Uint8Array
}

interface ResultMap {
  object: MediaInfoType
  JSON: string
  XML: string
  HTML: string
  text: string
}

const DEFAULT_OPTIONS = {
  coverData: false,
  chunkSize: 256 * 1024,
  format: 'object',
  full: false,
} as const

/**
 * Convenience wrapper for MediaInfoLib WASM module.
 */
class MediaInfo<TFormat extends FormatType = typeof DEFAULT_OPTIONS.format> {
  private readonly mediainfoModule: MediaInfoModule
  private readonly mediainfoModuleInstance: MediaInfoWasmInterface
  readonly options: MediaInfoOptions<TFormat>

  /**
   * Create an instance of MediaInfo. The constructor should not be called directly.
   * Instead use {@link MediaInfoFactory}.
   *
   * @param mediainfoModule WASM module
   * @param options User options
   */
  constructor(mediainfoModule: MediaInfoModule, options: MediaInfoOptions<TFormat>) {
    this.mediainfoModule = mediainfoModule
    this.options = options

    // Instantiate
    this.mediainfoModuleInstance = new mediainfoModule.MediaInfo(
      options.format === 'object' ? 'JSON' : options.format,
      options.coverData,
      options.full
    )
  }

  /**
   * Convenience method for analyzing a buffer chunk by chunk.
   *
   * @param getSize Return total buffer size in bytes.
   * @param readChunk Read chunk of data and return an {@link Uint8Array}.
   */
  analyzeData(getSize: GetSizeFunc, readChunk: ReadChunkFunc): Promise<ResultMap[TFormat]>

  /**
   * Convenience method for analyzing a buffer chunk by chunk.
   *
   * @param getSize Return total buffer size in bytes.
   * @param readChunk Read chunk of data and return an {@link Uint8Array}.
   * @param callback Function that is called once the processing is done
   */
  analyzeData(
    getSize: GetSizeFunc,
    readChunk: ReadChunkFunc,
    callback: (result: ResultMap[TFormat], err?: Error) => void
  ): void

  analyzeData(
    getSize: GetSizeFunc,
    readChunk: ReadChunkFunc,
    callback?: (result: ResultMap[TFormat], err?: Error) => void
  ): Promise<ResultMap[TFormat]> | void {
    let offset = 0

    if (callback === undefined) {
      return new Promise((resolve, reject) =>
        this.analyzeData(getSize, readChunk, (result: ResultMap[TFormat], err) =>
          err ? reject(err) : resolve(result)
        )
      )
    }

    const runReadDataLoop = (fileSize: number) => {
      const getChunk = () => {
        const readNextChunk = (data: Uint8Array) => {
          if (continueBuffer(data)) {
            getChunk()
          } else {
            finalize()
          }
        }
        let dataValue
        try {
          const safeSize = Math.min(
            this.options.chunkSize ?? DEFAULT_OPTIONS.chunkSize,
            fileSize - offset
          )
          dataValue = readChunk(safeSize, offset)
        } catch (e) {
          if (e instanceof Error) {
            return callback('', e)
          } else if (typeof e === 'string') {
            return callback('', new Error(e))
          }
        }
        if (dataValue instanceof Promise) {
          dataValue.then(readNextChunk).catch((e) => callback('', e))
        } else if (dataValue !== undefined) {
          readNextChunk(dataValue)
        }
      }

      const continueBuffer = (data: Uint8Array): boolean => {
        if (data.length === 0 || this.openBufferContinue(data, data.length)) {
          return false
        }
        const seekTo: number = this.openBufferContinueGotoGet()
        if (seekTo === -1) {
          offset += data.length
        } else {
          offset = seekTo
          this.openBufferInit(fileSize, seekTo)
        }
        return true
      }

      const finalize = () => {
        this.openBufferFinalize()
        const result = this.inform()
        callback(this.options.format === 'object' ? JSON.parse(result) : result)
      }

      this.openBufferInit(fileSize, offset)
      getChunk()
    }

    const fileSizeValue = getSize()
    if (fileSizeValue instanceof Promise) {
      fileSizeValue.then(runReadDataLoop)
    } else {
      runReadDataLoop(fileSizeValue)
    }
  }

  /**
   * Close the MediaInfoLib WASM instance.
   */
  close(): void {
    this.mediainfoModuleInstance.close()
    this.mediainfoModule.destroy(this.mediainfoModuleInstance)
  }

  /**
   * Receive result data from the WASM instance.
   *
   * (This is a low-level MediaInfoLib function.)
   *
   * @returns Result data (format can be configured in options)
   */
  inform(): string {
    return this.mediainfoModuleInstance.inform()
  }

  /**
   * Send more data to the WASM instance.
   *
   * (This is a low-level MediaInfoLib function.)
   *
   * @param data Data buffer
   * @param size Buffer size
   * @returns Processing state: `0` (no bits set) = not finished, Bit `0` set = enough data read for providing information
   */
  openBufferContinue(data: Uint8Array, size: number): boolean {
    // bit 3 set -> done
    return !!(this.mediainfoModuleInstance.open_buffer_continue(data, size) & 0x08)
  }

  /**
   * Retrieve seek position from WASM instance.
   * The MediaInfoLib function `Open_Buffer_GoTo` returns an integer with 64 bit precision.
   * It would be cut at 32 bit due to the JavaScript bindings. Here we transport the low and high
   * parts separately and put them together.
   *
   * (This is a low-level MediaInfoLib function.)
   *
   * @returns Seek position (where MediaInfoLib wants go in the data buffer)
   */
  openBufferContinueGotoGet(): number {
    // JS bindings don't support 64 bit int
    // https://github.com/buzz/mediainfo.js/issues/11
    let seekTo = -1
    const seekToLow: number = this.mediainfoModuleInstance.open_buffer_continue_goto_get_lower()
    const seekToHigh: number = this.mediainfoModuleInstance.open_buffer_continue_goto_get_upper()
    if (seekToLow == -1 && seekToHigh == -1) {
      seekTo = -1
    } else if (seekToLow < 0) {
      seekTo = seekToLow + 4294967296 + seekToHigh * 4294967296
    } else {
      seekTo = seekToLow + seekToHigh * 4294967296
    }
    return seekTo
  }

  /**
   * Inform MediaInfoLib that no more data is being read.
   */
  openBufferFinalize(): void {
    this.mediainfoModuleInstance.open_buffer_finalize()
  }

  /**
   * Prepare MediaInfoLib to process a data buffer.
   *
   * @param size Expected buffer size
   * @param offset Buffer offset
   */
  openBufferInit(size: number, offset: number): void {
    this.mediainfoModuleInstance.open_buffer_init(size, offset)
  }
}

export type { FormatType, GetSizeFunc, ReadChunkFunc, ResultMap }
export { DEFAULT_OPTIONS }
export default MediaInfo
