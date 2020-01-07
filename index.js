window.addEventListener('load', async () => {
  const response = await fetch('Prag.map');
  const arrayBuffer = await response.arrayBuffer();
  console.dir(new Mapsforge(arrayBuffer));
});

class Mapsforge {
  constructor(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const textDecoder = new TextDecoder();
    const magicByte = textDecoder.decode(arrayBuffer.slice(0, 20));
    if (magicByte !== 'mapsforge binary OSM') {
      throw new Error(`The magic byte '${magicByte}' doesn't not equal 'mapsforge binary OSM'.`);
    }

    this.magicByte = magicByte;

    let cursor = 20;
    function advance(bytes) {
      const _cursor = cursor;
      cursor += bytes;
      return _cursor;
    }

    this.headerSize = dataView.getUint32(advance(4));
    this.fileVersion = dataView.getUint32(advance(4));
    const fileSize = (advance(8), null); // TODO: getUint64
    const dateOfCreation = (advance(8), null); // TODO: getUint64
    this.minLatMicroDegrees = dataView.getUint32(advance(4));
    this.minLonMicroDegrees = dataView.getUint32(advance(4));
    this.maxLatMicroDegrees = dataView.getUint32(advance(4));
    this.maxLonMicroDegrees = dataView.getUint32(advance(4));
    this.tileSizePixels = dataView.getUint16(advance(2));

    function parseVbeu() {
      let byte;
      let value = 0;
      let index = 0;

      do {
        // Multiply each number by this factor so that bit index as well as byte index give the final value
        const factor = Math.pow(2, index * 7);

        byte = dataView.getUint8(cursor + index);
        value += (byte & 64) * factor + (byte & 32) * factor + (byte & 16) * factor + (byte & 8) * factor + (byte & 4) * factor + (byte & 2) * factor + (byte & 1) * factor;
        index++;
      } while (byte & 128 /* Continue looking if the initial bit is non-zero, can only be 0 or 128. */);

      cursor += index;
      return value;
    }

    const projectionLength = parseVbeu();
    this.projection = textDecoder.decode(arrayBuffer.slice(cursor, cursor + projectionLength));
    cursor += projectionLength;
    const flags = dataView.getUint8(advance(1));
    this.hasDebug = Boolean(flags & 128);
    this.hasMapStart = Boolean(flags & 64);
    this.hasStartZoom = Boolean(flags & 32);
    this.hasLangPref = Boolean(flags & 16);
    this.hasComment = Boolean(flags & 8);
    this.hasCreatedBy = Boolean(flags & 4);

    if (this.hasMapStart) {
      this.latMicroDegrees = dataView.getUint32(advance(4));
      this.lonMicroDegrees = dataView.getUint32(advance(4));
    }

    if (this.hasStartZoom) {
      this.startZoom = dataView.getUint8(advance(1));
    }

    if (this.hasLangPref) {
      throw new Error('Maps with language preferences are not supported yet!');
    }

    if (this.hasComment) {
      const commentLength = parseVbeu();
      this.comment = textDecoder.decode(arrayBuffer.slice(cursor, cursor + commentLength));
      cursor += commentLength;
    }

    if (this.hasCreatedBy) {
      const createdByLength = parseVbeu();
      this.createdBy = textDecoder.decode(arrayBuffer.slice(cursor, cursor + createdByLength));
      cursor += createdByLength;
    }

    const poiTagCount = dataView.getUint16(advance(2));
    this.poiTags = [];
    for (let id = 0; id < poiTagCount; id++) {
      const tagLength = parseVbeu();
      this.poiTags.push(textDecoder.decode(arrayBuffer.slice(cursor, cursor + tagLength)));
      cursor += tagLength;
    }

    const wayTagCount = dataView.getUint16(advance(2));
    this.wayTags = [];
    for (let id = 0; id < wayTagCount; id++) {
      const tagLength = parseVbeu();
      this.wayTags.push(textDecoder.decode(arrayBuffer.slice(cursor, cursor + tagLength)));
      cursor += tagLength;
    }

    const zoomItervalCount = dataView.getUint8(advance(1));
    this.zoomIntervals = [];
    for (let index = 0; index < zoomItervalCount; index++) {
      const baseZoomLevel = dataView.getUint8(advance(1));
      const minZoomLevel = dataView.getUint8(advance(1));
      const maxZoomLevel = dataView.getUint8(advance(1));

      // TODO: getUint64
      const startPosTop = dataView.getUint32(advance(4));
      const startPosBottom = dataView.getUint32(advance(4));
      if (startPosTop !== 0) {
        throw new Error('Absolute zoom positions larger than 32bits are not supported yet.');
      }

      const startPos = startPosBottom;

      const sizeTop = dataView.getUint32(advance(4));
      const sizeBottom = dataView.getUint32(advance(4));
      if (sizeTop !== 0) {
        throw new Error('Sizes larger than 32bits are not supported yet.');
      }

      const size = sizeBottom;

      this.zoomIntervals.push({ baseZoomLevel, minZoomLevel, maxZoomLevel, startPos, size });
    }

    // TODO: Verify the number of zoom levels is equal to the number of subfiles
    for (let index = 0; index < this.zoomIntervals.length; index++) {
      if (this.hasDebug) {
        throw new Error('Reading tile index segments with debug bit set is not implemented yet.');
      }


      // https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
      function lon2tile(lon, zoom) { return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom))); }
      function lat2tile(lat, zoom) { return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom))); }
      const zoom = this.zoomIntervals[index].baseZoomLevel;
      const northEdge = this.minLatMicroDegrees / 1000000;
      const topTile = lat2tile(northEdge, zoom);
      const westEdge = this.minLonMicroDegrees / 1000000;
      const leftTile = lon2tile(westEdge, zoom);
      const southEdge = this.maxLatMicroDegrees / 1000000;
      const bottomTile = lat2tile(southEdge, zoom);
      const eastEdge = this.maxLonMicroDegrees / 1000000;
      const rightTile = lon2tile(eastEdge, zoom);
      const width = Math.abs(leftTile - rightTile) + 1;
      const height = Math.abs(topTile - bottomTile) + 1;

      // TODO: Verify this is actually correct, looks suspect: 1, 4, 520
      const tileCount = width * height;
      for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
        // TODO: https://github.com/mapsforge/mapsforge/blob/master/docs/Specification-Binary-Map-File.md#tile-index-entry
      }

      // TODO: https://github.com/mapsforge/mapsforge/blob/master/docs/Specification-Binary-Map-File.md#tile-header
    }
  }
}
