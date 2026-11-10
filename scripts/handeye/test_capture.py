import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import struct
import zlib

path = Path(__file__).resolve().parents[2] / 'src-tauri/src/handeye_capture.py'
spec = importlib.util.spec_from_file_location('capture', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class CaptureTest(unittest.TestCase):
    def rows(self):
        return [{'stamp_ns': 1_000_000_000 + i*20_000_000, 'names': ['joint'+str(n) for n in range(1, 7)], 'positions': [0.]*6, 'velocities': [0.]*6} for i in range(21)]
    def test_stopped_fresh_measured_feedback(self):
        result=m.stable_feedback(self.rows(), 1_400_000_000, 1_410_000_000)
        self.assertEqual(result['stamp_ns'], 1_400_000_000)
    def test_missing_stale_future_moving_and_partial_feedback(self):
        self.assertIsNone(m.stable_feedback([],1_400_000_000,1_410_000_000))
        self.assertIsNone(m.stable_feedback(self.rows(),1_400_000_000,2_000_000_000))
        self.assertIsNone(m.stable_feedback(self.rows(),1_400_000_000,1_000_000_000))
        for key,value in [('velocities',[.03]*6),('positions',[float('nan')]*6),('names',['joint1']*6),('positions',[0.]*5),('velocities',[])]:
            rows=self.rows();rows[10][key]=value
            self.assertIsNone(m.stable_feedback(rows,1_400_000_000,1_410_000_000),key)
        rows=self.rows();rows[-1]['positions'][2]=.003
        self.assertIsNone(m.stable_feedback(rows,1_400_000_000,1_410_000_000))
    def test_no_too_short_window_or_old_matching_frame(self):
        self.assertIsNone(m.stable_feedback(self.rows()[-5:],1_400_000_000,1_410_000_000))
        self.assertIsNone(m.stable_feedback(self.rows(),1_700_000_000,1_710_000_000))
        rows=self.rows()
        self.assertIsNone(m.stable_feedback([rows[0],rows[10],rows[-1]],1_400_000_000,1_410_000_000))
    def test_png_encoder_channel_order_padding_and_corrupt_buffers(self):
        for encoding, source, expected, color in [
            ('bgr8', bytes([3,2,1,99,6,5,4,99]), bytes([0,1,2,3,0,4,5,6]), 2),
            ('rgb8', bytes([1,2,3,99,4,5,6,99]), bytes([0,1,2,3,0,4,5,6]), 2),
            ('bgra8', bytes([3,2,1,255,6,5,4,128]), bytes([0,1,2,3,255,0,4,5,6,128]), 6),
            ('rgba8', bytes([1,2,3,255,4,5,6,128]), bytes([0,1,2,3,255,0,4,5,6,128]), 6),
            ('mono8', bytes([8,99,9,99]), bytes([0,8,0,9]), 0),
        ]:
            image=SimpleNamespace(width=1,height=2,step=len(source)//2,data=source,encoding=encoding)
            png=m.encode_image(image)
            self.assertEqual(png[:8],b'\x89PNG\r\n\x1a\n')
            self.assertEqual(png[25],color)
            length=struct.unpack('>I',png[33:37])[0]
            self.assertEqual(zlib.decompress(png[41:41+length]),expected)
            image.data=source[:-1]
            with self.assertRaises(ValueError):m.encode_image(image)
    def test_tf_matrix_and_invalid_quaternion(self):
        t=SimpleNamespace(translation=SimpleNamespace(x=1.,y=2.,z=3.),rotation=SimpleNamespace(x=0.,y=0.,z=0.,w=1.))
        self.assertEqual(m.transform_matrix(t),[1.,0.,0.,1.,0.,1.,0.,2.,0.,0.,1.,3.,0,0,0,1])
        t.rotation.w=0
        with self.assertRaises(ValueError):m.transform_matrix(t)
    def test_config_rejects_shell_and_frame_errors(self):
        c=dict(image_topic='/image',camera_info_topic='/info',joint_topic='/joints',base_frame='base',eef_frame='eef',sensor_frame='optical',camera_body_frame='camera',mode='capture')
        m.validate_config(c)
        for key,value in [('mode','execute'),('image_topic','/x;reboot'),('base_frame','eef')]:
            with self.assertRaises(ValueError):m.validate_config({**c,key:value})

if __name__=='__main__':unittest.main()
