// Dummy shim for node-only dependencies like jsdom, canvas, and xmldom
export class JSDOM {}
export const canvas = null;
export const xmldom = null;
const defaultExport = {};
export default defaultExport;
