import * as THREE from "three";
import c3d from '../../../build/Release/c3d.node';
import { MaterialOverride, TemporaryObject } from "../../editor/GeometryDatabase";
import * as visual from '../../visual_model/VisualModel';
import { composeMainName, vec2vec } from '../../util/Conversion';
import { GeometryFactory, NoOpError, PhantomInfo } from '../../command/GeometryFactory';
import { MoveParams } from "../translate/TranslateFactory";
import { AtomicRef } from "../../util/Util";
import { derive } from "../../command/FactoryBuilder";

export interface BooleanLikeFactory extends GeometryFactory {
    set target(target: visual.Solid | c3d.Solid);
    set tool(target: visual.Solid | c3d.Solid);

    operationType: c3d.OperationType;

    // NOTE: These are hints for the factory to infer which operation
    isOverlapping: boolean;
    isSurface: boolean;
}

export interface BooleanParams {
    operationType: c3d.OperationType;
    mergingFaces: boolean;
    mergingEdges: boolean;
}

export class BooleanFactory extends GeometryFactory implements BooleanLikeFactory, BooleanParams {
    private _operationType = c3d.OperationType.Difference;
    get operationType() { return this._operationType }
    set operationType(operationType: c3d.OperationType) { this._operationType = operationType }

    mergingFaces = true;
    mergingEdges = true;

    isOverlapping = false;
    isSurface = false;

    protected _target!: { view: visual.Solid, model: c3d.Solid };
    @derive(visual.Solid) get target(): visual.Solid { throw '' }
    set target(solid: visual.Solid | c3d.Solid) { }

    private _tools: visual.Solid[] = [];
    protected toolModels: c3d.Solid[] = [];
    get tools() { return this._tools }
    set tools(tools: visual.Solid[]) {
        this._tools = tools;
        this.toolModels = tools.map(t => this.db.lookup(t));
    }

    set tool(solid: visual.Solid | c3d.Solid) {
        this.toolModels = [solid instanceof visual.Solid ? this.db.lookup(solid) : solid];
    }

    protected readonly names = new c3d.SNameMaker(composeMainName(c3d.CreatorType.BooleanSolid, this.db.version), c3d.ESides.SideNone, 0);
    protected _isOverlapping = false;

    async calculate() {
        const { _target: { model: solid }, toolModels, names, mergingFaces, mergingEdges } = this;

        const flags = new c3d.MergingFlags();
        flags.SetMergingFaces(mergingFaces);
        flags.SetMergingEdges(mergingEdges);

        const { result } = await c3d.ActionSolid.UnionResult_async(solid, c3d.CopyMode.Copy, toolModels, c3d.CopyMode.Copy, this.operationType, true, flags, names, false);
        this._isOverlapping = true;
        return result;
    }

    async calculatePhantoms(): Promise<PhantomInfo[]> {
        const result = await this.calculateToolPhantoms();
        result.push(await this.calculateTargetPhantom());
        return result;
    }

    async calculateToolPhantoms(): Promise<PhantomInfo[]> {
        const { operationType, toolModels: tools } = this;

        let material: MaterialOverride;
        if (operationType === c3d.OperationType.Difference) material = phantom_red
        else if (operationType === c3d.OperationType.Intersect) material = phantom_green;
        else material = phantom_blue;

        const result: PhantomInfo[] = [];
        for (const phantom of tools) {
            result.push({ phantom, material })
        }
        return result;
    }

    async calculateTargetPhantom(): Promise<PhantomInfo> {
        const { _target: { model: solid } } = this;
        return { phantom: solid, material: phantom_blue }
    }

    get originalItem() {
        let result = [];
        if (this.target !== undefined) result.push(this.target);
        result = result.concat(this.tools);
        return result;
    }

    get shouldRemoveOriginalItemOnCommit() {
        return true;
    }
}

type ToolAndTargetPhantoms = { tools: TemporaryObject[], target: TemporaryObject, dirty: boolean };

export class MovingBooleanFactory extends BooleanFactory implements MoveParams {
    move = new THREE.Vector3();
    pivot = new THREE.Vector3();

    override get operationType() { return super.operationType }
    override set operationType(operationType: c3d.OperationType) {
        this.dirty();
        super.operationType = operationType;
    }

    override get target(): visual.Solid { return super.target }
    override set target(target: visual.Solid | c3d.Solid) {
        super.target = target;
        this.dirty();
    }

    override get tools() { return super.tools }
    override set tools(tools: visual.Solid[]) {
        super.tools = tools;
        this.dirty();
    }

    async calculate() {
        const { _target: { model: solid }, names, mergingFaces, mergingEdges, toolModels } = this;
        if (solid === undefined) throw new NoOpError();
        if (toolModels.length === 0) return solid;

        const tools = this.moveTools();

        const flags = new c3d.MergingFlags();
        flags.SetMergingFaces(mergingFaces);
        flags.SetMergingEdges(mergingEdges);

        try {
            const { result } = await c3d.ActionSolid.UnionResult_async(solid, c3d.CopyMode.Copy, tools, c3d.CopyMode.Copy, this.operationType, false, flags, names, false);
            this._isOverlapping = true;
            return result;
        } catch (e) {
            const error = e as { isC3dError: boolean, code: number };
            if (error.isC3dError && error.code === 25) return solid;
            else throw e;
        }
    }

    private moveTools() {
        let tools = [];
        const { move, toolModels } = this;
        if (move.manhattanLength() > 10e-6) {
            const transform = new c3d.TransformValues();
            transform.Move(vec2vec(move));
            const names = new c3d.SNameMaker(composeMainName(c3d.CreatorType.TransformedSolid, this.db.version), c3d.ESides.SideNone, 0);
            for (const tool of toolModels) {
                const transformed = c3d.ActionDirect.TransformedSolid(tool, c3d.CopyMode.Copy, transform, names);
                tools.push(transformed);
            }
        } else tools = toolModels;
        return tools;
    }

    private readonly phantoms = new AtomicRef<ToolAndTargetPhantoms | undefined>(undefined);
    protected async doPhantoms(abortEarly: () => boolean): Promise<TemporaryObject[]> {
        const { clock, value } = this.phantoms.get();
        if (value === undefined || value.dirty) {
            const toolInfos = await super.calculateToolPhantoms();
            const targetInfo = await super.calculateTargetPhantom();
            const promises: Promise<TemporaryObject>[] = [];
            for (const { phantom, material } of toolInfos) {
                promises.push(this.db.addPhantom(phantom, material));
            }
            const targetPhantom = await this.db.addPhantom(targetInfo.phantom, targetInfo.material);
            let toolPhantoms = await Promise.all(promises);
            if (value?.dirty) {
                value.tools.forEach(t => t.cancel());
                value.target.cancel();
            }
            this.phantoms.compareAndSet(clock, { tools: toolPhantoms, target: targetPhantom, dirty: false });
        }
        const { tools, target } = this.phantoms.get().value!;
        MovePhantomsOnUpdate: {
            for (const phantom of tools) {
                phantom.underlying.position.copy(this.move);
            }
        }
        return this.showTemps([...tools, target]);
    }

    private dirty() {
        const phantoms = this.phantoms.get().value;
        if (phantoms !== undefined) {
            phantoms.dirty = true;
        }
    }
}


export abstract class PossiblyBooleanFactory<GF extends GeometryFactory> extends GeometryFactory {
    protected abstract bool: BooleanLikeFactory;
    protected abstract fantom: GF;

    newBody = false;

    protected _operationType?: c3d.OperationType;
    get operationType() { return this._operationType ?? this.defaultOperationType }
    set operationType(operationType: c3d.OperationType) { this._operationType = operationType }
    get defaultOperationType() { return this.isSurface ? c3d.OperationType.Union : c3d.OperationType.Difference }

    protected _target?: visual.Solid;
    protected model?: c3d.Solid;
    get target() { return this._target }
    set target(target: visual.Solid | undefined) {
        this._target = target;
        if (target !== undefined) {
            this.bool.target = target;
            this.model = this.db.lookup(target);
        }
    }

    protected _isOverlapping = false;
    get isOverlapping() { return this._isOverlapping }
    set isOverlapping(isOverlapping: boolean) {
        this._isOverlapping = isOverlapping;
        this.bool.isOverlapping = isOverlapping;
    }

    protected _isSurface = false;
    get isSurface() { return this._isSurface }
    set isSurface(isSurface: boolean) {
        this._isSurface = isSurface;
        this.bool.isSurface = isSurface;
    }

    private async beforeCalculate(fast = false) {
        const phantom = await this.fantom.calculate() as c3d.Solid;
        let isOverlapping, isSurface;
        if (this.target === undefined) {
            isOverlapping = false;
            isSurface = false;
        } else {
            const cube1 = this.model!.GetCube();
            const cube2 = phantom.GetCube();
            if (!cube1.Intersect(cube2)) {
                isOverlapping = false;
                isSurface = false;
            } else {
                isOverlapping = await c3d.Action.IsSolidsIntersectionFast_async(this.model!, phantom, new c3d.SNameMaker(0, c3d.ESides.SideNone, 0));
                isSurface = false;
            }
        }
        return { phantom, isOverlapping, isSurface };
    }

    async calculate() {
        const { phantom, isOverlapping, isSurface } = await this.beforeCalculate();
        this.isOverlapping = isOverlapping; this.isSurface = isSurface;
        if (isOverlapping && !this.newBody) {
            this.bool.operationType = this.operationType;
            this.bool.tool = phantom;
            const result = await this.bool.calculate() as c3d.Solid;
            return result;
        } else {
            return phantom;
        }
    }

    async calculatePhantoms(): Promise<PhantomInfo[]> {
        const phantom = await this.fantom.calculate() as c3d.Solid;
        const isOverlapping = this.isOverlapping;

        if (this.target === undefined) return [];
        if (this.newBody) return [];
        if (this.operationType === c3d.OperationType.Union) return [];
        if (!isOverlapping) return [];

        let material: MaterialOverride
        if (this.operationType === c3d.OperationType.Difference) material = phantom_red;
        else if (this.operationType === c3d.OperationType.Intersect) material = phantom_green;
        else material = phantom_blue;

        return [{ phantom, material }];
    }

    get originalItem() { return this.target }

    get shouldRemoveOriginalItemOnCommit() {
        return this.isOverlapping && this.target !== undefined && !this.newBody;
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

const phantom_red: MaterialOverride = {
    mesh: mesh_red
}

const mesh_green = new THREE.MeshBasicMaterial();
mesh_green.color.setHex(0x00ff00);
mesh_green.opacity = 0.1;
mesh_green.transparent = true;
mesh_green.fog = false;
mesh_green.polygonOffset = true;
mesh_green.polygonOffsetFactor = 0.1;
mesh_green.polygonOffsetUnits = 1;

const phantom_green: MaterialOverride = {
    mesh: mesh_green
}


const mesh_blue = new THREE.MeshBasicMaterial();
mesh_blue.color.setHex(0x0000ff);
mesh_blue.opacity = 0.1;
mesh_blue.transparent = true;
mesh_blue.fog = false;
mesh_blue.polygonOffset = true;
mesh_blue.polygonOffsetFactor = 0.1;
mesh_blue.polygonOffsetUnits = 1;

const phantom_blue: MaterialOverride = {
    mesh: mesh_blue
}
