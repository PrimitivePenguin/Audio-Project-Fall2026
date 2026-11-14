// from https://github.com/PrimitivePenguin/contour
export let gridRes = null; // grid cell size, saved by setup() and used by draw()

// Ken Perlin noise implementation
export class Perlin {
    constructor() {
        this.permutation = [];
        for (let i = 0; i < 256; i++) this.permutation[i] = i;
        // Shuffle
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.permutation[i], this.permutation[j]] = [this.permutation[j], this.permutation[i]];
        }
        this.permutation = this.permutation.concat(this.permutation);
    }

    fade(t) { 
        return t * t * t * (t * (t * 6 - 15) + 10); 
    }

    lerp(t, a, b) { 
        return a + t * (b - a); 
    }

    grad(hash, x, y, z) {
        const h = hash & 15;   // take the last 4 bits of hash
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
        return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
    }

    noise(x, y, z = 0) {
        // Find unit cube containing point
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const Z = Math.floor(z) & 255;

        // Relative coords in cube
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const zf = z - Math.floor(z);

        // Fade curves
        const u = this.fade(xf);
        const v = this.fade(yf);
        const w = this.fade(zf);

        // Hash coordinates of cube corners
        const p = this.permutation;
        const A  = p[X] + Y;
        const AA = p[A] + Z;
        const AB = p[A + 1] + Z;
        const B  = p[X + 1] + Y;
        const BA = p[B] + Z;
        const BB = p[B + 1] + Z;

        // Add blended results from all 8 cube corners
        const val = this.lerp(w, 
            this.lerp(v, 
                this.lerp(u, this.grad(p[AA], xf, yf, zf),
                             this.grad(p[BA], xf - 1, yf, zf)),
                this.lerp(u, this.grad(p[AB], xf, yf - 1, zf),
                             this.grad(p[BB], xf - 1, yf - 1, zf))
            ),
            this.lerp(v,
                this.lerp(u, this.grad(p[AA + 1], xf, yf, zf - 1),
                             this.grad(p[BA + 1], xf - 1, yf, zf - 1)),
                this.lerp(u, this.grad(p[AB + 1], xf, yf - 1, zf - 1),
                             this.grad(p[BB + 1], xf - 1, yf - 1, zf - 1))
            )
        );

        return (val + 1) / 2; // normalize to [0, 1]
    }
}

// One shared noise instance for this module (module-level variables aren't visible to other files)
const perlin = new Perlin();

// INPUT:  field: 2D array, scale, dfactor: horizontal zoom, t: time,
//         height: vertical exaggeration (1 = normal, 2 = twice as steep)
// OUTPUT: field filled with values 0..255
// ACTION: samples noise per cell; height stretches values away from the
//         middle (0.5) so hills get taller/valleys deeper without changing their width
export function generatePerlin(field, scale, dfactor, t, height = 1) {
    for (let i = 0; i < field.length; i++) {
        for (let j = 0; j < field[i].length; j++) {
            let x = i * scale;
            let y = j * scale;
            let dampening = dfactor;
            let value = perlin.noise(x * dampening ,y * dampening,t);
            value = 0.5 + (value - 0.5) * height;
            value = Math.min(1, Math.max(0, value)); // clamp: peaks past the top become flat plateaus
            field[i][j] = 255 * value;
        }
    }
    //console.log("t = ", t);
    //console.log(field);
    return field;
}

export function setup(res, containerID) {
    gridRes = res;
    // Get the SVG element and setup
    const mesh = document.getElementById(containerID);
    let width = mesh.clientWidth;
    let height = mesh.clientHeight;
    // cols and rows to the nearest multiple of 2

    let cols = Math.floor(width / res);
    let rows = Math.floor(height / res);
    // multiple of two to make sure the marching square algorithm works
    if (width % 2 !== 0) {
        cols = Math.floor(width / res) + 1;
    }
    if (height % 2 !== 0) {
        rows = Math.floor(height / res) + 1;
    }
    let field = [];

    // circle parameters
    let z = 0;
    let r = 200;
    let cx = width / 2;
    let cy = height / 2;

    for (let i = 0; i < cols; i++) {
        field[i] = [];
        for (let j = 0; j < rows; j++) {
            field[i][j] = 0;
            // let x = i * res;
            // let y = j * res;

            // //let inCirc = (((x - cx) ** 2 + (y - cy) ** 2 + (z ** 2)) < (r ** 2)) ? true : false;
            // let distance = (x - cx) ** 2 + (y - cy) ** 2 + (z ** 2);
            // let inCirc = distance < (r ** 2) ? true : false;

            // // assign color instead of just 1/0
            // if (inCirc == true) {
            //     // further away from the source, more white it is, closer to the center more black.
            //     //distance - r = 0 => 0, distance = 0 -> 255 (need to normalize)
            //     let value = 255 - ((r ** 2) - distance) / (r ** 2) * 255;
            //     field[i][j] = value;
            // } else {
            //     field[i][j] =  82;
            // // }
        }
    }
    return field;
}