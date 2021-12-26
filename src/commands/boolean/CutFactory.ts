import * as THREE from "three";
import c3d from '../../../build/Release/c3d.node';
import { PlaneSnap } from "../../editor/snaps/Snap";
import * as visual from '../../visual_model/VisualModel';
import { composeMainName, ContourAndPlacement, curve3d2curve2d, deunit, point2point, vec2vec } from '../../util/Conversion';
import { ExtrudeSurfaceFactory } from "../extrude/ExtrudeSurfaceFactory";
import { GeometryFactory, PhantomInfo, ValidationError } from '../../command/GeometryFactory';

export interface CutParams {
    mergingFaces: boolean;
    mergingEdges: boolean;
    constructionPlane?: PlaneSnap;
}

type CutMode = { tag: 'contour', contour: c3d.Contour, placement: c3d.Placement3D } | { tag: 'surface', surface: c3d.Surface }

abstract class AbstractCutFactory extends GeometryFactory implements CutParams {
    constructionPlane?: PlaneSnap;
    mergingFaces = true;
    mergingEdges = true;
    protected mode!: CutMode;

    private fantom = new ExtrudeSurfaceFactory(this.db, this.materials, this.signals);
    protected abstract names: c3d.SNameMaker;

    private _solid!: visual.Solid;
    protected model!: c3d.Solid;
    get solid(): visual.Solid { return this._solid }
    set solid(solid: visual.Solid | c3d.Solid) {
        if (solid instanceof visual.Solid) {
            this.model = this.db.lookup(solid);
            this._solid = solid;
        } else {
            this.model = solid;
        }
    }

    set curve(inst: visual.SpaceInstance<visual.Curve3D> | ContourAndPlacement) {
        let curve2d, placement;
        if (inst instanceof visual.SpaceInstance) {
            const instance = this.db.lookup(inst);
            const item = instance.GetSpaceItem()!;
            const curve3d = item.Cast<c3d.Curve3D>(item.IsA());
            const planar = curve3d2curve2d(curve3d, this.constructionPlane?.placement ?? new c3d.Placement3D());
            if (planar === undefined) throw new ValidationError("Curve cannot be converted to planar");
            curve2d = planar.curve;
            placement = planar.placement;
        } else {
            const planar = inst;
            curve2d = planar.curve;
            placement = planar.placement;
        }
        this.mode = { tag: 'contour', contour: new c3d.Contour([curve2d], true), placement };
    }

    set surface(surface: visual.Face | c3d.Surface) {
        if (surface instanceof visual.Face) {
            const model = this.db.lookupTopologyItem(surface);
            this.mode = { tag: 'surface', surface: model.GetSurface().GetSurface() }
        } else {
            this.mode = { tag: 'surface', surface }
        }
    }

    protected async computePhantom() {
        const { mode, fantom, model: solid } = this;

        switch (mode.tag) {
            case 'contour':
                const { placement, contour } = mode;
                const Z = vec2vec(placement.GetAxisZ(), 1);
                const bbox = new c3d.Cube();
                solid.AddYourGabaritTo(bbox);
                const inout_max = bbox.pmax;
                const inout_min = bbox.pmin;
                placement.GetPointInto(inout_max);
                placement.GetPointInto(inout_min);
                Z.multiplyScalar(deunit(inout_max.z) - deunit(inout_min.z));

                fantom.model = new c3d.PlaneCurve(placement, contour, true);
                fantom.direction = Z;
                this._phantom = await fantom.calculate();
                break;
            case 'surface':
                this._phantom = new c3d.SpaceInstance(mode.surface);
        }
    }

    get originalItem() { return this.solid }

    protected _phantom!: c3d.SpaceInstance;
    get phantoms() {
        const phantom = this._phantom;
        const material = { surface: surface_red };
        return [{ phantom, material }];
    }
}

export class CutFactory extends AbstractCutFactory {
    protected names = new c3d.SNameMaker(composeMainName(c3d.CreatorType.CuttingSolid, this.db.version), c3d.ESides.SideNone, 0);

    async calculate() {
        const { params, model: solid } = this;

        this.computePhantom();

        const results = c3d.ActionSolid.SolidCutting(solid, c3d.CopyMode.Copy, params);
        return [...results];
    }

    get params() {
        const { mode, names } = this;
        const flags = new c3d.MergingFlags(true, true);
        const direction = new c3d.Vector3D(0, 0, 0);

        switch (mode.tag) {
            case 'contour':
                return new c3d.ShellCuttingParams(mode.placement, mode.contour, false, direction, flags, true, names);;
            case 'surface':
                const params = new c3d.ShellCuttingParams(mode.surface, false, flags, true, names);
                params.AddSurfaceProlongType(c3d.SurfaceProlongType.Extrusion);
                return params;
        }
    }
}

export class SplitFactory extends AbstractCutFactory {
    private _faces!: visual.Face[];
    private models!: c3d.Face[];
    get faces() { return this._faces; }
    set faces(faces: visual.Face[]) {
        this._faces = faces;
        const models = [];
        for (const face of faces) {
            models.push(this.db.lookupTopologyItem(face));
        }
        this.models = models;
        this.solid = faces[0].parentItem;
    }

    protected names = new c3d.SNameMaker(composeMainName(c3d.CreatorType.CuttingSolid, this.db.version), c3d.ESides.SideNone, 0);

    async calculate() {
        const { db, mode, names, models: faces, model: solid } = this;

        const flags = new c3d.MergingFlags(true, true);

        this.computePhantom();

        switch (mode.tag) {
            case 'contour':
                return c3d.ActionSolid.SplitSolid_async(solid, c3d.CopyMode.Copy, mode.placement, c3d.SenseValue.BOTH, [mode.contour], false, faces, flags, names);
            case 'surface':
                return c3d.ActionSolid.SplitSolidBySpaceItem_async(solid, c3d.CopyMode.Copy, [mode.surface], false, faces, flags, names);
        }
    }
}

export class CutAndSplitFactory extends GeometryFactory implements CutParams {
    private cut = new CutFactory(this.db, this.materials, this.signals);
    private split = new SplitFactory(this.db, this.materials, this.signals);

    get faces() { return this.split.faces ?? []; }
    set faces(faces: visual.Face[]) {
        if (faces.length > 0) this.split.faces = faces;
    }
    set solid(solid: visual.Solid) { this.cut.solid = solid; }

    set curve(curve: visual.SpaceInstance<visual.Curve3D>) { this.cut.curve = curve; this.split.curve = curve; }
    set surface(plane: visual.Face) { this.cut.surface = plane; this.split.surface = plane; }
    set mergingFaces(mergingFaces: boolean) { this.cut.mergingFaces = mergingFaces; this.split.mergingFaces = mergingFaces; }
    set mergingEdges(mergingEdges: boolean) { this.cut.mergingEdges = mergingEdges; this.split.mergingEdges = mergingEdges; }
    set constructionPlane(constructionPlane: PlaneSnap | undefined) { this.cut.constructionPlane = constructionPlane; this.split.constructionPlane = constructionPlane; }

    async calculate() {
        const { faces, cut, split } = this;
        if (faces.length === 0) return cut.calculate();
        else return [await split.calculate()];
    }

    get phantoms() {
        const { faces, cut, split } = this;
        if (faces.length === 0) return cut.phantoms;
        else return split.phantoms;
    }

    get originalItem() {
        const { faces, cut, split } = this;
        if (faces.length === 0) return cut.originalItem;
        else return split.originalItem;
    }
}

export class MultiCutFactory extends GeometryFactory implements CutParams {
    mergingFaces = true;
    mergingEdges = true;
    constructionPlane?: PlaneSnap | undefined;

    private _solids!: visual.Solid[];
    protected models!: c3d.Solid[];
    get solids(): visual.Solid[] { return this._solids }
    set solids(solids: visual.Solid[]) {
        this.models = solids.map(solid => this.db.lookup(solid));
        this._solids = solids;
    }

    private _surfaces: c3d.Surface[] = [];
    set surfaces(faces: visual.Face[]) {
        this._surfaces = faces.map(face => this.db.lookupTopologyItem(face).GetSurface().GetSurface());
    }

    private _curves: ContourAndPlacement[] = [];
    set curves(insts: visual.SpaceInstance<visual.Curve3D>[]) {
        const result = [];
        for (const inst of insts) {
            const instance = this.db.lookup(inst);
            const item = instance.GetSpaceItem()!;
            const curve3d = item.Cast<c3d.Curve3D>(item.IsA());
            const planar = curve3d2curve2d(curve3d, this.constructionPlane?.placement ?? new c3d.Placement3D());
            if (planar === undefined) throw new ValidationError("Curve cannot be converted to planar");
            result.push(planar);
        }
        this._curves = result;
    }

    async calculate() {
        const { _surfaces: surfaces, _curves: curves, models: solids } = this;
        const cutters = [...surfaces, ...curves];
        let parts: c3d.Solid[] = solids;
        let phantoms: PhantomInfo[] = [];
        for (const cutter of cutters) {
            let pass: Promise<c3d.Solid[]>[] = [];
            for (const [i, part] of parts.entries()) {
                const cut = new CutFactory(this.db, this.materials, this.signals);
                cut.solid = part;
                if (cutter instanceof c3d.Surface) cut.surface = cutter;
                else cut.curve = cutter;
                const promise = cut.calculate().catch(e => [part]);
                if (i === 0) { // FIXME: this is very ugly
                    promise.then(() => {
                        phantoms = phantoms.concat(cut.phantoms);
                    });
                }
                pass.push(promise);
            }
            parts = (await Promise.all(pass)).flat();
        }
        this._phantoms = phantoms;
        return parts;
    }

    private _phantoms!: PhantomInfo[];
    get phantoms() {
        return this._phantoms;
    }

    protected get originalItem() {
        return this.solids;
    }
}

const mesh_red = new THREE.MeshBasicMaterial();
mesh_red.color.setHex(0xff0000);
mesh_red.opacity = 0.1;
mesh_red.transparent = true;
mesh_red.fog = false;
mesh_red.polygonOffset = true;
mesh_red.polygonOffsetFactor = 0.1;
mesh_red.polygonOffsetUnits = 1;

const surface_red = mesh_red.clone();
surface_red.side = THREE.DoubleSide;

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);