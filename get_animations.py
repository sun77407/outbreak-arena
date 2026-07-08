import json
import struct
import sys
import glob
import os

def get_glb_animations(filepath):
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        if magic != b'glTF':
            return []
        version, length = struct.unpack('<II', f.read(8))
        chunk_len, chunk_type = struct.unpack('<II', f.read(8))
        if chunk_type != 0x4E4F534A: # 'JSON'
            return []
        json_data = f.read(chunk_len).decode('utf-8')
        gltf = json.loads(json_data)
        animations = gltf.get('animations', [])
        return [anim.get('name', 'Unnamed') for anim in animations]

def main():
    directory = r'e:\webproject\OutbreakArena\assets\Models\GLB format'
    glbs = glob.glob(os.path.join(directory, 'character-*.glb'))
    for glb in glbs:
        name = os.path.basename(glb)
        anims = get_glb_animations(glb)
        print(f"{name}: {anims}")

if __name__ == '__main__':
    main()
