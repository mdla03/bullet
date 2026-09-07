/*
    Copyright 2018 0KIMS association.

    This file is part of circom (Zero Knowledge Circuit Compiler).

    circom is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    circom is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with circom. If not, see <https://www.gnu.org/licenses/>.
*/
// Ported from: circomlib/circuits/escalarmulw4table.circom (circomlib v2.0.5,
// vendored in circuits/node_modules/circomlib).
// Changes from the original:
//   - The compile-time pointAdd() function's a, d constants replaced with
//     Jubjub's curve constants (see circuits/scripts/jubjub-ref.mjs).
// Only valid when compiled with `circom -p bls12381`.
pragma circom 2.0.0;

function pointAdd(x1,y1,x2,y2) {
    var a = 52435875175126190479447740508185965837690552500527637822603658699938581184512;
    var d = 19257038036680949359750312669786877991949435402254120286184196891950884077233;

    var res[2];
    res[0] = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2);
    res[1] = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2);
    return res;
}

function EscalarMulW4Table(base, k) {
    var out[16][2];

    var i;
    var p[2];

    var dbl[2] = base;

    for (i=0; i<k*4; i++) {
        dbl = pointAdd(dbl[0], dbl[1], dbl[0], dbl[1]);
    }

    out[0][0] = 0;
    out[0][1] = 1;
    for (i=1; i<16; i++) {
        p = pointAdd(out[i-1][0], out[i-1][1], dbl[0], dbl[1]);
        out[i][0] = p[0];
        out[i][1] = p[1];
    }

    return out;
}
