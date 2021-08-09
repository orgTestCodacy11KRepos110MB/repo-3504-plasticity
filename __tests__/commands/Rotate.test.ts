import * as THREE from "three";
import { ThreePointBoxFactory } from "../../src/commands/box/BoxFactory";
import RotateFactory from '../../src/commands/rotate/RotateFactory';
import { EditorSignals } from '../../src/editor/EditorSignals';
import { GeometryDatabase } from '../../src/editor/GeometryDatabase';
import MaterialDatabase from '../../src/editor/MaterialDatabase';
import * as visual from '../../src/editor/VisualModel';
import { FakeMaterials } from "../../__mocks__/FakeMaterials";
import '../matchers';

let db: GeometryDatabase;
let rotate: RotateFactory;
let materials: Required<MaterialDatabase>;
let signals: EditorSignals;

beforeEach(() => {
    materials = new FakeMaterials();
    signals = new EditorSignals();
    db = new GeometryDatabase(materials, signals);
    rotate = new RotateFactory(db, materials, signals);
})

describe('update', () => {
    test('rotates the visual object', async () => {
        const item = new visual.Solid();
        rotate.items = [item];
        rotate.point = new THREE.Vector3();
        rotate.axis = new THREE.Vector3(0, 0, 1);
        rotate.angle = Math.PI / 2;
        expect(item).toHaveQuaternion(new THREE.Quaternion(0, 0, 0, 1));

        await rotate.update();

        expect(item).toHaveQuaternion(new THREE.Quaternion().setFromAxisAngle(rotate.axis, rotate.angle));
        expect(db.temporaryObjects.children.length).toBe(0); // FIXME this is a weird implementation
    });
});

describe('commit', () => {
    test('invokes the appropriate c3d commands', async () => {
        expect(db.temporaryObjects.children.length).toBe(0);
        expect(db.visibleObjects.length).toBe(0);

        const makeBox = new ThreePointBoxFactory(db, materials, signals);
        makeBox.p1 = new THREE.Vector3();
        makeBox.p2 = new THREE.Vector3(1, 0, 0);
        makeBox.p3 = new THREE.Vector3(1, 1, 0);
        makeBox.p4 = new THREE.Vector3(1, 1, 1);
        const box = await makeBox.commit() as visual.Solid;

        expect(box).toHaveCentroidNear(new THREE.Vector3(0.5, 0.5, 0.5));

        rotate.items = [box];
        rotate.point = new THREE.Vector3();
        rotate.axis = new THREE.Vector3(0, 0, 1);
        rotate.angle = Math.PI / 2;
        const rotated = (await rotate.commit())[0];

        expect(rotated).toBeInstanceOf(visual.Solid);
        expect(rotated).toHaveCentroidNear(new THREE.Vector3(-0.5, 0.5, 0.5));

        expect(db.temporaryObjects.children.length).toBe(0);
        expect(db.visibleObjects.length).toBe(1);
    })
});