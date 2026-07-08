const fs = require('fs');
const path = require('path');

function getGlbAnimations(filepath) {
    const buffer = fs.readFileSync(filepath);
    const magic = buffer.toString('utf8', 0, 4);
    if (magic !== 'glTF') return [];
    
    // const version = buffer.readUInt32LE(4);
    // const length = buffer.readUInt32LE(8);
    
    const chunkLen = buffer.readUInt32LE(12);
    const chunkType = buffer.readUInt32LE(16);
    
    if (chunkType !== 0x4E4F534A) return []; // 'JSON'
    
    const jsonData = buffer.toString('utf8', 20, 20 + chunkLen);
    const gltf = JSON.parse(jsonData);
    
    const animations = gltf.animations || [];
    return animations.map(a => a.name || 'Unnamed');
}

const dir = 'e:\\webproject\\OutbreakArena\\assets\\Models\\GLB format';
const files = fs.readdirSync(dir);
const characters = files.filter(f => f.startsWith('character-') && f.endsWith('.glb'));

characters.forEach(char => {
    const anims = getGlbAnimations(path.join(dir, char));
    console.log(`${char}: ${anims.join(', ')}`);
});
