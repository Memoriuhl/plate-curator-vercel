import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch

torch.set_num_threads(2)
request = json.load(sys.stdin)
plates = request['plates']
if not 1 <= len(plates) <= 25 or len({plate['id'] for plate in plates}) != len(plates):
    raise ValueError('Group scope must contain 1 to 25 distinct plates')
if len({plate['state'] for plate in plates}) != 1:
    raise ValueError('Group scope must contain one state')
legacy = Path(os.environ['LOCAL_GROUP_LEGACY_REPO']).resolve() / 'refiner' / 'plate_match.py'
spec = importlib.util.spec_from_file_location('plate_match', legacy)
pm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pm)
model = pm.load_model('dinov2_vits14', 'cpu')
options = request['options']
features = []
with torch.no_grad():
    for plate in plates:
        rgb = pm.load_rgb(Path(plate['path']))
        if options.get('backgroundMask'):
            rgb = pm.mask_foreground(rgb)
        tensor = torch.from_numpy(np.stack([pm.to_chw(rgb)]))
        vector = pm.extract_embedding(model, tensor, SimpleNamespace(attn_bg=False)).cpu().numpy()[0].astype(np.float32)
        if options.get('colorSignal'):
            vector = np.concatenate([vector, pm.color_sig(rgb).astype(np.float32) * 0.3])
            vector /= max(float(np.linalg.norm(vector)), 1e-8)
        features.append(vector)
vectors = np.stack(features)
indices = {plate['id']: i for i, plate in enumerate(plates)}
groups, count = pm._cluster_cc(plates, vectors, indices, 0.85)
print(json.dumps({'groups': groups, 'similarities': (vectors @ vectors.T).tolist(), 'model': 'dinov2_vits14', 'count': count}, allow_nan=False))
