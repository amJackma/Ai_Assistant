import { desktopCapturer, screen } from 'electron'

export interface SelectionRectangle {
  x: number
  y: number
  width: number
  height: number
}

const MAX_IMAGE_EDGE = 2200

export class ScreenCaptureService {
  async captureRegion(
    displayId: number,
    selection: SelectionRectangle,
  ): Promise<Buffer> {
    const display = screen.getAllDisplays().find((item) => item.id === displayId)
    if (!display) throw new Error('The selected display is no longer available.')

    const requestedSize = {
      width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor)),
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: requestedSize,
      fetchWindowIcons: false,
    })
    const source = sources.find((item) => item.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('The selected display could not be captured.')
    }

    const imageSize = source.thumbnail.getSize()
    const scaleX = imageSize.width / display.bounds.width
    const scaleY = imageSize.height / display.bounds.height
    const crop = {
      x: Math.max(0, Math.round(selection.x * scaleX)),
      y: Math.max(0, Math.round(selection.y * scaleY)),
      width: Math.min(
        imageSize.width,
        Math.max(1, Math.round(selection.width * scaleX)),
      ),
      height: Math.min(
        imageSize.height,
        Math.max(1, Math.round(selection.height * scaleY)),
      ),
    }
    crop.width = Math.min(crop.width, imageSize.width - crop.x)
    crop.height = Math.min(crop.height, imageSize.height - crop.y)
    if (crop.width <= 0 || crop.height <= 0) {
      throw new Error('The selected screen region is empty.')
    }

    let image = source.thumbnail.crop(crop)
    const size = image.getSize()
    const resizeScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height))
    if (resizeScale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(size.width * resizeScale)),
        height: Math.max(1, Math.round(size.height * resizeScale)),
        quality: 'best',
      })
    }
    const png = image.toPNG()
    if (png.byteLength === 0) throw new Error('The selected image could not be encoded.')
    return png
  }
}
